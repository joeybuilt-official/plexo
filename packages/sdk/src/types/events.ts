// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Event Bus Types
 * Corresponds to §7.4 of the Kapsel Protocol Specification v0.2.0
 *
 * Extensions may only publish to ext.<scope>.* namespace.
 * Standard topics are published by the host.
 */

/** Standard topics published by the host. Extensions subscribe but cannot publish these. */
export const TOPICS = {
    TASK_CREATED: 'task.created',
    TASK_COMPLETED: 'task.completed',
    TASK_FAILED: 'task.failed',
    TASK_BLOCKED: 'task.blocked',
    CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
    CHANNEL_HEALTH_CHANGED: 'channel.health.changed',
    EXTENSION_ACTIVATED: 'extension.activated',
    EXTENSION_DEACTIVATED: 'extension.deactivated',
    EXTENSION_CRASHED: 'extension.crashed',
    CONNECTION_ADDED: 'connection.added',
    CONNECTION_REMOVED: 'connection.removed',
    MEMORY_WRITTEN: 'memory.written',
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

// Standard topic payloads
export interface TaskCreatedPayload { taskId: string; title: string; type: string; workspaceId: string }
export interface TaskCompletedPayload { taskId: string; durationMs: number; workspaceId: string }
export interface TaskFailedPayload { taskId: string; error: string; workspaceId: string }
export interface TaskBlockedPayload { taskId: string; reason: string; workspaceId: string }
export interface ChannelMessageReceivedPayload { channelId: string; messageId: string; senderId: string }
export interface ChannelHealthChangedPayload { channelId: string; healthy: boolean; latencyMs?: number }
export interface ExtensionActivatedPayload { name: string; version: string; type: string; workspaceId: string }
export interface ExtensionDeactivatedPayload { name: string; workspaceId: string }
export interface ExtensionCrashedPayload { name: string; error: string; workspaceId: string }
export interface ConnectionAddedPayload { service: string; workspaceId: string }
export interface ConnectionRemovedPayload { service: string; workspaceId: string }
export interface MemoryWrittenPayload { id: string; tags?: string[]; authorExtension: string; workspaceId: string }
