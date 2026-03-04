/**
 * Kapsel Activation SDK — v2 with host bridge
 *
 * A host-side implementation of KapselSDK passed to extension activate() calls.
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
import type { KapselSDK, ToolRegistration, ScheduleRegistration, WidgetRegistration } from '@plexo/sdk'

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
): { sdk: KapselSDK; getResult: () => ActivationResult } {
    const capSet = new Set(capabilities)
    const registered: ActivationResult = { tools: [], schedules: [], widgets: [] }

    function requireCap(token: string): void {
        if (!capSet.has(token)) {
            throw new Error(`CAPABILITY_DENIED: extension "${extensionName}" requires "${token}" capability`)
        }
    }

    const sdk: KapselSDK = {
        host: {
            kapselVersion: '0.2.0',
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

        memory: {
            async read(query, opts) {
                requireCap('memory:read')
                return bridge('memory.read', {
                    workspaceId,
                    query,
                    tags: opts?.tags,
                    limit: opts?.limit,
                }) as Promise<Awaited<ReturnType<KapselSDK['memory']['read']>>>
            },
            async write(entry) {
                requireCap('memory:write')
                return bridge('memory.write', {
                    workspaceId,
                    content: entry.content,
                    tags: entry.tags,
                    metadata: { ...entry.metadata, authorExtension: extensionName },
                    ttl: entry.ttl,
                }) as Promise<Awaited<ReturnType<KapselSDK['memory']['write']>>>
            },
            async delete(id) {
                requireCap('memory:delete')
                await bridge('memory.delete', { workspaceId, id })
            },
        },

        connections: {
            async getCredentials(service: string) {
                requireCap(`connections:${service}`)
                return bridge('connections.getCredentials', { workspaceId, service }) as
                    Promise<Awaited<ReturnType<KapselSDK['connections']['getCredentials']>>>
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
                    Promise<Awaited<ReturnType<KapselSDK['tasks']['create']>>>
            },
            async get(id) {
                requireCap('tasks:read')
                return bridge('tasks.get', { workspaceId, id }) as
                    Promise<Awaited<ReturnType<KapselSDK['tasks']['get']>>>
            },
            async list(filter) {
                requireCap('tasks:read')
                return bridge('tasks.list', { workspaceId, filter }) as
                    Promise<Awaited<ReturnType<KapselSDK['tasks']['list']>>>
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
                // Check settings snapshot first (immutable at activation time)
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
    }

    return { sdk, getResult: () => ({ ...registered }) }
}
