// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for session logs (ADR-0045 Phase 2).
 *
 * The ONLY logger module permitted to import the ORM / db client.
 */

import { db, sessionLogs } from '@plexo/db'
import type { SessionLogStore, SessionLogInsert } from './ports'

export class DrizzleSessionLogStore implements SessionLogStore {
    async append(record: SessionLogInsert): Promise<void> {
        await db.insert(sessionLogs).values(record)
    }
}
