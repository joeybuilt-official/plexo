// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Fabric Event Bus Types
 * Corresponds to §7.4 of the Plexo Fabric Specification v0.4.0
 *
 * Extensions may only publish to ext.<scope>.* namespace.
 * Standard topics are published by the host.
 *
 * v0.4.0 additions:
 *   - prompt.* topics (§7.6)
 *   - context.* topics (§7.7)
 *
 * v0.3.0 additions:
 *   - entity.* topics (§16)
 *   - escalation.* topics (§23)
 *   - audit.* topics (§18)
 *   - self.* topics (§20)
 *   - agent.* topics (core architecture)
 *   - a2a.* topics (§22)
 */

import type { EntityTypeName } from './manifest.js'
import type { EscalationTrigger, EscalationUserResponse } from './escalation.js'
import type { AuditAction, AuditOutcome } from './audit.js'

/** Standard topics published by the host. Extensions subscribe but cannot publish these. */
export const TOPICS = {
    // Task lifecycle
    TASK_CREATED: 'task.created',
    TASK_COMPLETED: 'task.completed',
    TASK_FAILED: 'task.failed',
    TASK_BLOCKED: 'task.blocked',
    // Channel
    CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
    CHANNEL_HEALTH_CHANGED: 'channel.health.changed',
    // Extension lifecycle
    EXTENSION_ACTIVATED: 'extension.activated',
    EXTENSION_DEACTIVATED: 'extension.deactivated',
    EXTENSION_CRASHED: 'extension.crashed',
    // Connection lifecycle
    CONNECTION_ADDED: 'connection.added',
    CONNECTION_REMOVED: 'connection.removed',
    // Memory
    MEMORY_WRITTEN: 'memory.written',
    // §16 — Entity lifecycle
    ENTITY_CREATED: 'entity.created',
    ENTITY_MODIFIED: 'entity.modified',
    ENTITY_DELETED: 'entity.deleted',
    ENTITY_LINKED: 'entity.linked',
    // §23 — Escalation
    ESCALATION_TRIGGERED: 'escalation.triggered',
    ESCALATION_RESOLVED: 'escalation.resolved',
    ESCALATION_TIMED_OUT: 'escalation.timed_out',
    // §18 — Audit (host-internal, owner-tier subscribe only)
    AUDIT_ENTRY_CREATED: 'audit.entry.created',
    // §20 — UserSelf
    SELF_UPDATED: 'self.updated',
    SELF_PROPOSAL_RECEIVED: 'self.proposal.received',
    // Agent lifecycle (core architecture — Agent ≠ Extension)
    AGENT_ACTIVATED: 'agent.activated',
    AGENT_DEACTIVATED: 'agent.deactivated',
    AGENT_PLAN_CREATED: 'agent.plan.created',
    AGENT_STEP_COMPLETED: 'agent.step.completed',
    AGENT_STEP_FAILED: 'agent.step.failed',
    // §22 — A2A
    A2A_INBOUND_RECEIVED: 'a2a.inbound.received',
    A2A_DELEGATION_SENT: 'a2a.delegation.sent',
    A2A_DELEGATION_COMPLETED: 'a2a.delegation.completed',
    // §7.6 — Prompt Library
    PROMPT_REGISTERED: 'prompt.registered',
    PROMPT_ENABLED: 'prompt.enabled',
    // §7.7 — Context Layer
    CONTEXT_REGISTERED: 'context.registered',
    CONTEXT_UPDATED: 'context.updated',
    CONTEXT_EXPIRED: 'context.expired',
} as const

export type StandardTopic = (typeof TOPICS)[keyof typeof TOPICS]

/**
 * Build an extension-scoped topic name.
 * Extensions MUST use this for events they publish.
 * @example customTopic('acme', 'stripe-monitor', 'mrr.updated')
 * // => 'ext.acme.stripe-monitor.mrr.updated'
 */
export function customTopic(scope: string, name: string, event: string): string {
    return `ext.${scope}.${name}.${event}`
}

// ---------------------------------------------------------------------------
// Standard topic payloads
// ---------------------------------------------------------------------------

// Task
export interface TaskCreatedPayload { taskId: string; title: string; type: string; workspaceId: string }
export interface TaskCompletedPayload { taskId: string; durationMs: number; workspaceId: string }
export interface TaskFailedPayload { taskId: string; error: string; workspaceId: string }
export interface TaskBlockedPayload { taskId: string; reason: string; workspaceId: string }

// Channel
export interface ChannelMessageReceivedPayload { channelId: string; messageId: string; senderId: string }
export interface ChannelHealthChangedPayload { channelId: string; healthy: boolean; latencyMs?: number }

// Extension
export interface ExtensionActivatedPayload { name: string; version: string; type: string; workspaceId: string }
export interface ExtensionDeactivatedPayload { name: string; workspaceId: string }
export interface ExtensionCrashedPayload { name: string; error: string; workspaceId: string }

// Connection
export interface ConnectionAddedPayload { service: string; workspaceId: string }
export interface ConnectionRemovedPayload { service: string; workspaceId: string }

// Memory
export interface MemoryWrittenPayload { id: string; tags?: string[]; authorExtension: string; workspaceId: string }

// §16 — Entity
export interface EntityCreatedPayload { entityType: EntityTypeName; entityId: string; createdBy: string; workspaceId: string }
export interface EntityModifiedPayload { entityType: EntityTypeName; entityId: string; modifiedBy: string; workspaceId: string }
export interface EntityDeletedPayload { entityType: EntityTypeName; entityId: string; deletedBy: string; workspaceId: string }
export interface EntityLinkedPayload { sourceType: EntityTypeName; sourceId: string; targetType: EntityTypeName; targetId: string; workspaceId: string }

// §23 — Escalation
export interface EscalationTriggeredPayload { extensionId: string; agentId?: string; trigger: EscalationTrigger; action: string; workspaceId: string }
export interface EscalationResolvedPayload { extensionId: string; agentId?: string; trigger: EscalationTrigger; response: EscalationUserResponse; workspaceId: string }
export interface EscalationTimedOutPayload { extensionId: string; agentId?: string; trigger: EscalationTrigger; workspaceId: string }

// §18 — Audit
export interface AuditEntryCreatedPayload { extensionId: string; action: AuditAction; outcome: AuditOutcome; target: string }

// §20 — UserSelf
export interface SelfUpdatedPayload { field: string; updatedBy: string }
export interface SelfProposalReceivedPayload { field: string; source: string; confidence: number }

// Agent lifecycle
export interface AgentActivatedPayload { name: string; version: string; workspaceId: string }
export interface AgentDeactivatedPayload { name: string; workspaceId: string }
export interface AgentPlanCreatedPayload { agentName: string; taskId: string; stepCount: number; workspaceId: string }
export interface AgentStepCompletedPayload { agentName: string; taskId: string; stepId: string; durationMs: number; workspaceId: string }
export interface AgentStepFailedPayload { agentName: string; taskId: string; stepId: string; error: string; workspaceId: string }

// §22 — A2A
export interface A2AInboundReceivedPayload { sourceEndpoint: string; taskId: string; workspaceId: string }
export interface A2ADelegationSentPayload { targetEndpoint: string; taskId: string; agentName: string; workspaceId: string }
export interface A2ADelegationCompletedPayload { targetEndpoint: string; taskId: string; status: string; workspaceId: string }

// §7.6 — Prompt Library
export interface PromptRegisteredPayload { extensionName: string; promptId: string; workspaceId: string }
export interface PromptEnabledPayload { promptId: string; workspaceId: string }

// §7.7 — Context Layer
export interface ContextRegisteredPayload { extensionName: string; contextId: string; workspaceId: string }
export interface ContextUpdatedPayload { extensionName: string; contextId: string; workspaceId: string }
export interface ContextExpiredPayload { extensionName: string; contextId: string; workspaceId: string }
