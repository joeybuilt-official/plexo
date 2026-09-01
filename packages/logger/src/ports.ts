// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session-log persistence port (ADR-0045 Phase 2, revised by ADR 0055).
 *
 * `SessionLogger` depends on this abstraction. The record shape is declared by
 * hand rather than derived from the drizzle table: `append` is a write, and
 * ADR-0045 asks for writes to be mapped rather than passed through — typed row
 * passthrough is allowed only on simple read-only paths. Declaring it here also
 * keeps `packages/logger` free of any dependency on `@plexo/db`.
 *
 * The adapter lives in `packages/db` (`session-log-store.ts`) and is the only
 * code that knows this maps onto the `session_logs` table.
 */

export interface SessionLogInsert {
    sessionId: string
    eventType: string
    id?: string
    userId?: string | null
    personaId?: string | null
    route?: string | null
    action?: string | null
    payload?: unknown
    responseCode?: number | null
    responseBody?: unknown
    errorMessage?: string | null
    errorStack?: string | null
    durationMs?: number | null
    llmModel?: string | null
    llmPromptTokens?: number | null
    llmCompletionTokens?: number | null
    outputType?: string | null
    outputSummary?: string | null
    createdAt?: Date
}

export interface SessionLogStore {
    /** Append one session-log row. */
    append(record: SessionLogInsert): Promise<void>
}
