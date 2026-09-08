// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the legacy provider-migration port (Stage 3). The only
 * migration module permitted to import the ORM. The two counts and the
 * settings read are the queries that used to sit in
 * `providers/migrate-to-instances.ts`; pulling the legacy shape out of the
 * jsonb blob happens here, so the port carries no `unknown`.
 */

import { db, workspaces } from '@plexo/db'
import { eq, sql } from 'drizzle-orm'
import type {
    ProviderMigrationStore,
    LegacyProviderConfig,
    LegacyVaultEntry,
    LegacyArbiterProvider,
} from './provider-migration.ports.js'

export class DrizzleProviderMigrationStore implements ProviderMigrationStore {
    async hasAnyInstances(workspaceId: string): Promise<boolean> {
        const [row] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*) AS count FROM provider_instances
            WHERE workspace_id = ${workspaceId}::uuid
        `)
        return Number(row?.count ?? 0) > 0
    }

    async hasUnmanagedInstances(workspaceId: string): Promise<boolean> {
        const [row] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*) AS count FROM provider_instances
            WHERE workspace_id = ${workspaceId}::uuid AND managed = false
        `)
        return Number(row?.count ?? 0) > 0
    }

    async getLegacyProviderConfig(workspaceId: string): Promise<LegacyProviderConfig | null> {
        const [row] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = row?.settings as Record<string, unknown> | null | undefined
        if (!settings) return null

        return {
            vault: (settings.vault ?? {}) as Record<string, LegacyVaultEntry>,
            arbiter: (settings.arbiter ?? {}) as {
                primaryProvider?: string
                primary?: string
                fallbackChain?: string[]
                fallbackOrder?: string[]
                providers?: Record<string, LegacyArbiterProvider>
            },
        }
    }
}
