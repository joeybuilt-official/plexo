// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Audit persistence port (ADR-0045 Phase 2).
 *
 * `audit.ts` depends on this abstraction; the drizzle adapter
 * (`audit.repository.ts`) is the only place that touches the ORM. The record
 * is a plain, fully-resolved row (nulls applied) — no drizzle types cross here.
 */

export interface AuditLogRecord {
    workspaceId: string
    extensionId: string
    extensionName: string | null
    extensionVersion: string | null
    agentId: string | null
    sessionId: string
    action: string
    target: string
    payloadHash: string
    outcome: string
    modelContext: { modelId?: string; modelProvider?: string } | null
    escalationOutcome: string | null
}

export interface AuditLogStore {
    /** Append one audit row. Implementations must not throw on write failure. */
    append(record: AuditLogRecord): Promise<void>
}
