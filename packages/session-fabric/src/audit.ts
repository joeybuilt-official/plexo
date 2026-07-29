// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — append-only security audit (Phase 1c, pure domain).
 *
 * The domain builds immutable records; the `AuditSink` port persists them
 * (valkey stream / structured logger adapter at the edge).
 */

export type AuditEventType =
    | 'token.issue'
    | 'token.revoke'
    | 'kill.engage'
    | 'kill.release'
    | 'drive.grant'
    | 'drive.revoke'
    | 'action.denied'

export interface AuditRecord {
    type: AuditEventType
    at: string
    actorId: string | null
    workspaceId: string | null
    sessionId: string | null
    detail: Record<string, unknown>
}

export interface AuditFields {
    actorId?: string | null
    workspaceId?: string | null
    sessionId?: string | null
    detail?: Record<string, unknown>
}

export function buildAuditRecord(type: AuditEventType, at: Date, fields: AuditFields = {}): AuditRecord {
    return {
        type,
        at: at.toISOString(),
        actorId: fields.actorId ?? null,
        workspaceId: fields.workspaceId ?? null,
        sessionId: fields.sessionId ?? null,
        detail: fields.detail ?? {},
    }
}

/** Port: append-only security-event sink (valkey/logger adapter at the edge). */
export interface AuditSink {
    append(record: AuditRecord): Promise<void>
}
