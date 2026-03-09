// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel SDK Interface
 * The complete API available to extensions via the sdk parameter in activate()
 * Corresponds to Appendix A of the Kapsel Protocol Specification v0.2.0
 */

import type { HostComplianceLevel, JSONSchema } from './manifest.js'

export type NotificationLevel = 'info' | 'warning' | 'error'
export type ExtensionName = `@${string}/${string}`

export interface HostInfo {
    kapselVersion: string
    complianceLevel: HostComplianceLevel
    name: string
    version: string
}

export interface MemoryEntry {
    id: string
    content: string
    tags?: string[]
    authorExtension: ExtensionName | 'host'
    metadata?: Record<string, unknown>
    createdAt: number
    updatedAt: number
    ttl?: number
}

export interface ConnectionCredentials {
    type: 'api_key' | 'oauth2' | 'basic' | 'webhook'
    data: Record<string, string>
}

export interface ScheduleRegistration {
    name: string
    /** 5-field cron expression */
    schedule: string
    /** IANA timezone string. Defaults to 'UTC'. */
    timezone?: string
    handler(): Promise<void>
}

export interface WidgetRegistration {
    name: string
    displayName: string
    displayType: 'metric' | 'chart' | 'list' | 'status' | 'custom'
    /** Refresh interval in seconds */
    refreshInterval: number
    dataHandler(config: unknown): Promise<unknown>
}

export interface ToolRegistration {
    /** Alphanumeric and underscores. Unique within the extension. */
    name: string
    /** Max 500 characters. Shown to agents. */
    description: string
    /** Must be type "object" at top level. */
    parameters: JSONSchema
    hints?: {
        estimatedMs?: number
        /** Hard timeout in ms. Host will abort if exceeded. Defaults to 30_000. */
        timeoutMs?: number
        hasSideEffects?: boolean
        idempotent?: boolean
    }
    handler(params: unknown, context: InvokeContext): Promise<unknown>
}

export interface InvokeContext {
    workspaceId: string
    taskId?: string
    requestId: string
}

export interface ToolSummary {
    name: string
    description: string
    ownerExtension: string
}

export interface TaskCreateOptions {
    title: string
    type: string
    context?: unknown
}

export interface TaskFilter {
    status?: string
    type?: string
}

/**
 * The complete Kapsel SDK interface.
 * All extension types receive this in their activate() call.
 * Methods only work if the corresponding capability is declared in kapsel.json.
 */
export interface KapselSDK {
    /** Information about the host runtime */
    host: HostInfo

    /**
     * Registration methods. Only valid during activate().
     * Calling after activation completes is a no-op with a warning.
     */
    registerTool(tool: ToolRegistration): void
    registerSchedule(job: ScheduleRegistration): void
    registerWidget(widget: WidgetRegistration): void

    memory: {
        /** Requires memory:read */
        read(query: string, options?: { tags?: string[]; limit?: number }): Promise<MemoryEntry[]>
        /** Requires memory:write */
        write(entry: {
            content: string
            tags?: string[]
            metadata?: Record<string, unknown>
            ttl?: number
        }): Promise<MemoryEntry>
        /** Requires memory:delete */
        delete(id: string): Promise<void>
    }

    connections: {
        /** Requires connections:<service> */
        getCredentials(service: string): Promise<ConnectionCredentials>
        isConnected(service: string): Promise<boolean>
    }

    channel: {
        /** Requires channel:send */
        send(message: { text: string; priority?: 'normal' | 'high' | 'urgent'; attachments?: unknown[] }): Promise<void>
        /** Requires channel:send-direct */
        sendDirect(channelId: string, message: unknown): Promise<void>
    }

    tasks: {
        /** Requires tasks:create (agent type only) */
        create(options: TaskCreateOptions): Promise<{ taskId: string }>
        /** Requires tasks:read */
        get(taskId: string): Promise<unknown>
        /** Requires tasks:read-all */
        list(filter?: TaskFilter): Promise<unknown[]>
    }

    events: {
        /** Requires events:subscribe */
        subscribe(topic: string, handler: (payload: unknown) => void): void
        /** Requires events:publish — namespace enforced to ext.<scope>.* */
        publish(topic: string, payload: unknown): Promise<void>
    }

    storage: {
        /** Requires storage:read */
        get(key: string): Promise<string | null>
        /** Requires storage:write */
        set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
        /** Requires storage:write */
        delete(key: string): Promise<void>
    }

    ui: {
        /** Requires ui:notify */
        notify(message: string, level?: NotificationLevel): Promise<void>
    }
}
