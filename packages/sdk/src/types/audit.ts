// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §18 — Audit Trail Requirement
 * Kapsel Protocol Specification v0.3.0
 *
 * Standard and Full compliance hosts MUST maintain an immutable audit ledger
 * per Extension per session. Trust in autonomous behavior requires verifiability.
 *
 * Rules:
 *   - audit:read capability required for owner-tier Extensions to query the ledger
 *   - Ledger entries MUST be immutable — no Extension modifies or deletes its own trail
 *   - Hosts MUST surface audit logs in admin UI
 *   - Audit log data residency follows host's declared policy (§19)
 */

import type { ModelContextEntry } from './model-context.js'

export type AuditAction =
    | 'function_invoked'
    | 'memory_read'
    | 'memory_write'
    | 'channel_send'
    | 'schedule_fired'
    | 'entity_created'
    | 'entity_modified'
    | 'external_request'
    | 'escalation_triggered'
    | 'escalation_resolved'

export type AuditOutcome = 'success' | 'failure' | 'denied'

export type EscalationOutcome = 'approve' | 'deny' | 'approve-and-remember'

export interface AuditEntry {
    extensionId: string
    /** Which Agent invoked this Extension, if any */
    agentId?: string
    sessionId: string
    /** ISO 8601 timestamp */
    timestamp: string
    action: AuditAction
    /** Entity ID, function name, channel, or external URL */
    target: string
    /** SHA-256 of input — not plaintext */
    payloadHash: string
    outcome: AuditOutcome
    /** §24 — LLM model context for this action */
    modelContext?: ModelContextEntry
    /** Escalation outcome if applicable */
    escalationOutcome?: EscalationOutcome
}

export interface AuditQuery {
    extensionId?: string
    agentId?: string
    sessionId?: string
    action?: AuditAction
    outcome?: AuditOutcome
    /** ISO 8601 range start */
    from?: string
    /** ISO 8601 range end */
    to?: string
    limit?: number
    offset?: number
}

export interface AuditQueryResult {
    entries: AuditEntry[]
    total: number
    hasMore: boolean
}
