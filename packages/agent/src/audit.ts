// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension audit logger.
 *
 * Fire-and-forget writes to `extension_audit_log`. Never blocks the executor.
 * Catches its own errors so a logging failure never kills agent execution.
 *
 * Phase 7 — carries per-extension identity (name + version) so the audit
 * trail can surface "which specific extension did this" without a join.
 */
import pino from 'pino'
import { createHash } from 'node:crypto'
import { db } from '@plexo/db'
import { extensionAuditLog } from '@plexo/db'
import { parseToolKey } from './audit-keys.js'

// Re-export for consumers that import helpers from the logger module.
export { parseToolKey }

const log = pino({ name: 'audit' })

export type AuditAction =
    | 'tool_invoke'
    | 'tool_timeout'
    | 'tool_error'
    | 'extension_activate'
    | 'escalation_request'
    | 'escalation_approve'
    | 'escalation_reject'
    | 'escalation_timeout'

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'timeout'

export interface AuditEntry {
    workspaceId: string
    extensionId: string
    /** Phase 7 — user-facing display name (optional, falls back to extensionId). */
    extensionName?: string
    /** Phase 7 — semver frozen at call time. */
    extensionVersion?: string
    agentId?: string
    sessionId: string
    action: AuditAction
    target: string
    payload: unknown
    outcome: AuditOutcome
    modelContext?: { modelId?: string; modelProvider?: string }
    escalationOutcome?: string
}

function hashPayload(payload: unknown): string {
    try {
        return createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')
    } catch {
        return 'hash_error'
    }
}

export async function logAuditEntry(entry: AuditEntry): Promise<void> {
    try {
        await db.insert(extensionAuditLog).values({
            workspaceId: entry.workspaceId,
            extensionId: entry.extensionId,
            extensionName: entry.extensionName ?? null,
            extensionVersion: entry.extensionVersion ?? null,
            agentId: entry.agentId ?? null,
            sessionId: entry.sessionId,
            action: entry.action,
            target: entry.target,
            payloadHash: hashPayload(entry.payload),
            outcome: entry.outcome,
            modelContext: entry.modelContext ?? null,
            escalationOutcome: entry.escalationOutcome ?? null,
        })
    } catch (err) {
        log.warn({ err, action: entry.action, target: entry.target }, 'Failed to write audit entry')
    }
}

export interface ExtensionIdentity {
    name: string
    version: string
    displayName?: string
}

/**
 * Batch-log multiple tool calls from a single step.
 * Fire-and-forget — errors caught per-entry.
 *
 * Pass `extensionIdentities` to map extension name → {version, displayName}
 * so calls from installed PEX extensions get rich identity in the log.
 */
export async function logToolCalls(params: {
    workspaceId: string
    sessionId: string
    agentId?: string
    modelId?: string
    modelProvider?: string
    extensionIdentities?: Map<string, ExtensionIdentity>
    toolCalls: Array<{
        tool: string
        input: unknown
        output: string
        extensionId?: string
    }>
}): Promise<void> {
    const {
        workspaceId, sessionId, agentId, modelId, modelProvider,
        toolCalls, extensionIdentities,
    } = params
    const modelContext = modelId ? { modelId, modelProvider } : undefined

    await Promise.allSettled(
        toolCalls.map((tc) => {
            // Resolve extension identity: explicit > parsed key > 'system'
            let extensionId = tc.extensionId ?? 'system'
            let extensionName: string | undefined
            let extensionVersion: string | undefined

            if (!tc.extensionId) {
                const parsed = parseToolKey(tc.tool)
                if (parsed) {
                    extensionId = parsed.extensionName
                }
            }

            if (extensionIdentities && extensionId !== 'system') {
                const ident = extensionIdentities.get(extensionId)
                if (ident) {
                    extensionName = ident.displayName ?? ident.name
                    extensionVersion = ident.version
                }
            }

            return logAuditEntry({
                workspaceId,
                extensionId,
                extensionName,
                extensionVersion,
                agentId,
                sessionId,
                action: 'tool_invoke',
                target: tc.tool,
                payload: tc.input,
                outcome: tc.output.includes('error') || tc.output.includes('Error') ? 'failure' : 'success',
                modelContext,
            })
        }),
    )
}
