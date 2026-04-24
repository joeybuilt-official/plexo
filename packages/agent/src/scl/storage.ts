// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Golden Record read/write layer.
 *
 * These are the ONLY functions that touch Postgres for Golden Record data.
 * All scl-core functions operate on in-memory GoldenRecord objects.
 * This layer handles serialization to/from JSONB.
 */

import { db, eq, sql } from '@plexo/db'
import { workspaceMindsets, workspaces } from '@plexo/db'
import type { GoldenRecord } from '@plexo/scl-core'
import pino from 'pino'

const logger = pino({ name: 'scl:storage' })

/**
 * Load the Golden Record for a workspace.
 * Returns null if SCL is not enabled or no record exists.
 */
export async function loadGoldenRecord(workspaceId: string): Promise<GoldenRecord | null> {
    try {
        const rows = await db.select({ goldenRecord: workspaceMindsets.goldenRecord })
            .from(workspaceMindsets)
            .where(eq(workspaceMindsets.workspaceId, workspaceId))
            .limit(1)

        const row = rows[0]
        if (!row?.goldenRecord) return null

        return row.goldenRecord as GoldenRecord
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to load Golden Record')
        return null
    }
}

/**
 * Save a Golden Record for a workspace.
 * Upserts — creates the workspace_mindsets row if it doesn't exist.
 */
export async function saveGoldenRecord(workspaceId: string, record: GoldenRecord): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO workspace_mindsets (workspace_id, golden_record, golden_record_version, updated_at)
            VALUES (${workspaceId}::uuid, ${JSON.stringify(record)}::jsonb, ${record.version}, NOW())
            ON CONFLICT (workspace_id)
            DO UPDATE SET
                golden_record = EXCLUDED.golden_record,
                golden_record_version = EXCLUDED.golden_record_version,
                updated_at = NOW()
        `)
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to save Golden Record')
        throw err
    }
}

/**
 * Check if SCL is enabled for a workspace.
 *
 * Phase 3a (intelligence overhaul) — primary home is
 * `workspaces.intelligence_settings.scl.enabled`. Falls back to the
 * legacy `workspaces.settings.scl_enabled` boolean for any workspace
 * that hasn't visited the new Settings → Intelligence → SCL page yet,
 * so the toggle migration is non-destructive.
 *
 * Cached for 60s via the same `agent-side` SCL settings cache used by
 * `loadSclRuntimeSettings` below — the executor calls this on every
 * conversation expand and we don't want a per-call DB hit.
 */
export async function isSclEnabled(workspaceId: string): Promise<boolean> {
    const settings = await loadSclRuntimeSettings(workspaceId)
    return settings.enabled
}

/**
 * Phase 3a — full SCL runtime tunables, read from
 * `workspaces.intelligence_settings.scl.*` with sensible defaults.
 *
 * The shape mirrors the IntelligenceSettings.scl block in
 * `apps/api/src/lib/intelligence-cache.ts`. Defaults are picked so a
 * workspace that has never touched the SCL settings page gets the
 * same behavior as the pre-Phase-3a code paths.
 */
export interface SclRuntimeSettings {
    enabled: boolean
    driftThreshold: number
    expandDepth: number
    expandWidth: number
    domainRegions: string[] | null
    piiScrubEnabled: boolean
}

export const SCL_RUNTIME_DEFAULTS: SclRuntimeSettings = {
    enabled: true,  // SCL is on by default — it's a core differentiator, not optional
    driftThreshold: 0.15,
    expandDepth: 1,
    expandWidth: 50,
    domainRegions: null,
    piiScrubEnabled: true,
}

interface CachedRuntimeSettings { value: SclRuntimeSettings; expiresAt: number }
const SCL_SETTINGS_TTL_MS = 60_000
const sclSettingsCache = new Map<string, CachedRuntimeSettings>()

/** Bust the executor-side SCL settings cache. The PATCH route calls this. */
export function invalidateSclRuntimeSettings(workspaceId: string): void {
    sclSettingsCache.delete(workspaceId)
}

/** Tests + admin reset. */
export function invalidateAllSclRuntimeSettings(): void {
    sclSettingsCache.clear()
}

export async function loadSclRuntimeSettings(workspaceId: string): Promise<SclRuntimeSettings> {
    const hit = sclSettingsCache.get(workspaceId)
    if (hit && hit.expiresAt > Date.now()) return hit.value

    let value: SclRuntimeSettings = { ...SCL_RUNTIME_DEFAULTS }
    try {
        const rows = await db.select({
            settings: workspaces.settings,
            intelligenceSettings: workspaces.intelligenceSettings,
        })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const row = rows[0]
        if (row) {
            const intelligence = (row.intelligenceSettings ?? {}) as Record<string, any>
            const sclBlock = (intelligence.scl ?? {}) as Record<string, any>
            const legacy = (row.settings ?? {}) as Record<string, any>

            value = {
                enabled: typeof sclBlock.enabled === 'boolean'
                    ? sclBlock.enabled
                    : (legacy.scl_enabled === true),
                driftThreshold: typeof sclBlock.driftThreshold === 'number'
                    ? sclBlock.driftThreshold
                    : SCL_RUNTIME_DEFAULTS.driftThreshold,
                expandDepth: typeof sclBlock.expandDepth === 'number'
                    ? sclBlock.expandDepth
                    : SCL_RUNTIME_DEFAULTS.expandDepth,
                expandWidth: typeof sclBlock.expandWidth === 'number'
                    ? sclBlock.expandWidth
                    : SCL_RUNTIME_DEFAULTS.expandWidth,
                domainRegions: Array.isArray(sclBlock.domainRegions)
                    ? (sclBlock.domainRegions as string[])
                    : null,
                piiScrubEnabled: typeof sclBlock.piiScrubEnabled === 'boolean'
                    ? sclBlock.piiScrubEnabled
                    : SCL_RUNTIME_DEFAULTS.piiScrubEnabled,
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to load SCL settings — defaulting')
    }
    sclSettingsCache.set(workspaceId, { value, expiresAt: Date.now() + SCL_SETTINGS_TTL_MS })
    return value
}

/**
 * Load the workspace's SCL mutation config overrides from
 * `workspaces.settings.sclConfig`. Returns only the fields that map
 * to `SCLConfig` from `@plexo/scl-core` so they can be passed as
 * `configOverride` to `mutate()`.
 *
 * Returns undefined if no overrides are saved (mutate will use defaults).
 */
export async function loadSclMutationConfig(workspaceId: string): Promise<Partial<import('@plexo/scl-core').SCLConfig> | undefined> {
    try {
        const rows = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>
        const saved = settings.sclConfig as Record<string, unknown> | undefined
        if (!saved || typeof saved !== 'object') return undefined

        // Pick only fields that SCLConfig recognizes
        const override: Record<string, number> = {}
        for (const key of [
            'spiritDriftThreshold',
            'refinementThreshold',
            'ghostDisplacementThreshold',
            'promotionMutationCount',
            'promotionMaxDrift',
            'refinementWeightIncoming',
        ] as const) {
            if (typeof saved[key] === 'number') {
                override[key] = saved[key] as number
            }
        }

        return Object.keys(override).length > 0 ? override : undefined
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to load SCL mutation config — using defaults')
        return undefined
    }
}

/**
 * Check if the workspace has consented to training data usage.
 */
export async function hasTrainingConsent(workspaceId: string): Promise<boolean> {
    try {
        const rows = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = rows[0]?.settings as Record<string, unknown> | null
        return settings?.training_data_consent === true
    } catch (err) {
        return false
    }
}
