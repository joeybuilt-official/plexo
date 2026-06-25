// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the extension audit log (ADR-0045 Phase 2).
 *
 * The ONLY audit module permitted to import the ORM / db client.
 */

import { db, extensionAuditLog } from '@plexo/db'
import type { AuditLogStore, AuditLogRecord } from './audit.ports.js'

export class DrizzleAuditLogStore implements AuditLogStore {
    async append(record: AuditLogRecord): Promise<void> {
        await db.insert(extensionAuditLog).values(record as typeof extensionAuditLog.$inferInsert)
    }
}
