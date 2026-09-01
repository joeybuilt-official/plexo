// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the session-log port (ADR 0055).
 *
 * Lives here rather than in `packages/logger` because the ORM belongs in the
 * Frameworks & Drivers ring. The dependency points inward — a driver
 * implementing an inner port — so `packages/logger` no longer imports
 * `@plexo/db` or `drizzle-orm` at all.
 */

import type { SessionLogStore, SessionLogInsert } from '@plexo/logger'
import { db } from './client'
import { sessionLogs } from './schema'

export class DrizzleSessionLogStore implements SessionLogStore {
    async append(record: SessionLogInsert): Promise<void> {
        await db.insert(sessionLogs).values(record)
    }
}
