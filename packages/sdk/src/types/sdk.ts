// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo SDK Interface
 * The complete API available to extensions and agents via the sdk parameter in activate()
 * Corresponds to Appendix A of the Plexo Fabric Specification v0.4.0
 */

import type { HostComplianceLevel, JSONSchema, EntityTypeName } from './manifest.js'
import type { PromptRegistration, PromptSummary } from './prompts.js'
import type { ContextRegistration, ContextSummary } from './context.js'
import type {
    KapselEntity,
    EntityTypeMap,
    EntitySearchQuery,
    EntitySearchResult,
    LinkedEntity,
} from './entities.js'
import type {
    UserSelf,
    UserSelfField,
    UserSelfProposal,
} from './user-self.js'
import type { AuditEntry, AuditQuery, AuditQueryResult } from './audit.js'
import type { EscalationRequest, EscalationResult } from './escalation.js'
import type { A2AAgentCard, A2ADelegation, A2ATaskResult } from './a2a.js'

export type NotificationLevel = 'info' | 'warning' | 'error'
export type ExtensionName = `@${string}/${string}`

export interface HostInfo {
    fabricVersion: string
    complianceLevel: HostComplianceLevel
    name: string
    version: string
    capabilities?: { prompts?: boolean; context?: boolean; tokenBudgeting?: boolean }
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
    /** §16 — Entity type this memory entry relates to, if any */
    entityType?: EntityTypeName
    /** §16 — Entity ID this memory entry relates to, if any */
    entityId?: string
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
 * The complete Plexo SDK interface.
 * All extension and agent types receive this in their activate() call.
 * Methods only work if the corresponding capability is declared in plexo.json.
 *
 * v0.4.0 additions:
 *   - registerPrompt / registerContext (§7.6, §7.7)
 *   - prompts.*     (§7.6 — Prompt Library)
 *   - context.*     (§7.7 — Context Layer)
 *
 * v0.3.0 additions:
 *   - entities.*    (§16 — Personal Entity Schema)
 *   - self.*        (§20 — Persistent UserSelf)
 *   - audit.*       (§18 — Audit Trail)
 *   - escalate()    (§23 — Escalation Contract)
 *   - a2a.*         (§22 — A2A Bridge Layer)
 */
export interface PlexoSDK {
    /** Information about the host runtime */
    host: HostInfo

    /**
     * Registration methods. Only valid during activate().
     * Calling after activation completes is a no-op with a warning.
     */
    registerTool(tool: ToolRegistration): void
    registerSchedule(job: ScheduleRegistration): void
    registerWidget(widget: WidgetRegistration): void
    /** §7.6 — Requires prompts:register */
    registerPrompt(prompt: PromptRegistration): void
    /** §7.7 — Requires context:register */
    registerContext(context: ContextRegistration): void

    // -----------------------------------------------------------------
    // Memory (§4 — entity-scoped at Standard + Full compliance)
    // -----------------------------------------------------------------

    memory: {
        /** Requires memory:read or memory:read:<entity_type> */
        read(query: string, options?: {
            tags?: string[]
            limit?: number
            /** §16 — Filter to a specific entity type */
            entityType?: EntityTypeName
        }): Promise<MemoryEntry[]>
        /** Requires memory:write or memory:write:<entity_type> */
        write(entry: {
            content: string
            tags?: string[]
            metadata?: Record<string, unknown>
            ttl?: number
            /** §16 — Associate with an entity type */
            entityType?: EntityTypeName
            /** §16 — Associate with an entity ID */
            entityId?: string
        }): Promise<MemoryEntry>
        /** Requires memory:delete */
        delete(id: string): Promise<void>
    }

    // -----------------------------------------------------------------
    // §16 — Personal Entity Resolution API
    // -----------------------------------------------------------------

    entities: {
        /**
         * Resolve a single entity by type and ID.
         * Requires memory:read:<entity_type>
         */
        resolve<T extends EntityTypeName>(
            type: T,
            id: string,
        ): Promise<EntityTypeMap[T] | null>

        /**
         * Search for entities of a given type.
         * Requires memory:read:<entity_type>
         */
        search<T extends EntityTypeName>(
            type: T,
            query: EntitySearchQuery,
        ): Promise<EntitySearchResult<EntityTypeMap[T]>>

        /**
         * Create a new entity.
         * Requires entity:create:<entity_type>
         */
        create<T extends EntityTypeName>(
            type: T,
            data: Omit<EntityTypeMap[T], 'id'>,
        ): Promise<EntityTypeMap[T]>

        /**
         * Link two entities together.
         * Requires entity:modify:<entity_type> for the source entity.
         */
        link(
            source: { type: EntityTypeName; id: string },
            target: LinkedEntity,
        ): Promise<void>
    }

    // -----------------------------------------------------------------
    // Connections
    // -----------------------------------------------------------------

    connections: {
        /** Requires connections:<service> */
        getCredentials(service: string): Promise<ConnectionCredentials>
        isConnected(service: string): Promise<boolean>
    }

    // -----------------------------------------------------------------
    // Channel
    // -----------------------------------------------------------------

    channel: {
        /** Requires channel:send */
        send(message: { text: string; priority?: 'normal' | 'high' | 'urgent'; attachments?: unknown[] }): Promise<void>
        /** Requires channel:send-direct */
        sendDirect(channelId: string, message: unknown): Promise<void>
    }

    // -----------------------------------------------------------------
    // Tasks
    // -----------------------------------------------------------------

    tasks: {
        /** Requires tasks:create (agent type only) */
        create(options: TaskCreateOptions): Promise<{ taskId: string }>
        /** Requires tasks:read */
        get(taskId: string): Promise<unknown>
        /** Requires tasks:read-all */
        list(filter?: TaskFilter): Promise<unknown[]>
    }

    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------

    events: {
        /** Requires events:subscribe */
        subscribe(topic: string, handler: (payload: unknown) => void): void
        /** Requires events:publish — namespace enforced to ext.<scope>.* */
        publish(topic: string, payload: unknown): Promise<void>
    }

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------

    storage: {
        /** Requires storage:read */
        get(key: string): Promise<string | null>
        /** Requires storage:write */
        set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
        /** Requires storage:write */
        delete(key: string): Promise<void>
    }

    // -----------------------------------------------------------------
    // UI
    // -----------------------------------------------------------------

    ui: {
        /** Requires ui:notify */
        notify(message: string, level?: NotificationLevel): Promise<void>
    }

    // -----------------------------------------------------------------
    // §20 — Persistent UserSelf
    // -----------------------------------------------------------------

    self: {
        /** Requires self:read — field-level scoping */
        read(fields: UserSelfField[]): Promise<Partial<UserSelf>>
        /** Requires self:write — contribute via structured proposals */
        propose(proposal: UserSelfProposal): Promise<void>
    }

    // -----------------------------------------------------------------
    // §18 — Audit Trail (owner tier only)
    // -----------------------------------------------------------------

    audit: {
        /** Requires audit:read — query the immutable audit ledger */
        query(query: AuditQuery): Promise<AuditQueryResult>
    }

    // -----------------------------------------------------------------
    // §23 — Escalation (Agent type only)
    // -----------------------------------------------------------------

    /**
     * Signal that the agent needs human approval before proceeding.
     * Host pauses execution, notifies user, and returns the result.
     * Requires agent type.
     */
    escalate(request: EscalationRequest): Promise<EscalationResult>

    // -----------------------------------------------------------------
    // §22 — A2A Bridge (Full compliance hosts)
    // -----------------------------------------------------------------

    a2a: {
        /**
         * Discover external A2A agents by endpoint.
         * Requires a2a:delegate
         */
        discover(endpoint: string): Promise<A2AAgentCard | null>
        /**
         * Delegate a task to an external A2A agent.
         * Requires a2a:delegate. Logged in audit trail.
         */
        delegate(delegation: A2ADelegation): Promise<A2ATaskResult>
    }

    // -----------------------------------------------------------------
    // §7.6 — Prompt Library
    // -----------------------------------------------------------------

    prompts: {
        /** Requires prompts:read */
        list(options?: { tags?: string[] }): Promise<PromptSummary[]>
        /** Requires prompts:read — resolve template with variables */
        resolve(promptId: string, variables?: Record<string, unknown>): Promise<string>
    }

    // -----------------------------------------------------------------
    // §7.7 — Context Layer
    // -----------------------------------------------------------------

    context: {
        /** Requires context:write — update content for a registered context block */
        update(contextId: string, content: string, options?: { ttl?: number; estimatedTokens?: number }): Promise<void>
        /** Requires context:read */
        list(): Promise<ContextSummary[]>
    }
}

/**
 * @deprecated Use PlexoSDK instead. Alias for backward compatibility.
 */
export type KapselSDK = PlexoSDK
