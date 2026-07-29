// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session-log persistence port (ADR-0045 Phase 2).
 *
 * `SessionLogger` depends on this abstraction; the drizzle adapter
 * (`drizzle-session-log-store.ts`) is the only place that touches the ORM /
 * db client. The insert type is the drizzle row type imported type-only
 * (ADR-0045 Conflict-2: typed passthrough is allowed; no ORM value crosses).
 */

import type { sessionLogs } from '@plexo/db'

export type SessionLogInsert = typeof sessionLogs.$inferInsert

export interface SessionLogStore {
    /** Append one session-log row. */
    append(record: SessionLogInsert): Promise<void>
}
