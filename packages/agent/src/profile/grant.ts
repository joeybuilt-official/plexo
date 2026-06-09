// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §3) — grant loading + enforcement gate.
 *
 * The pure intersection logic lives in ./resolve.ts. This module is the DB-backed
 * side: it reads the operator-managed workspace_app_grants table and decides
 * whether enforcement applies to a given tool-load.
 */
import { db, eq, and } from '@plexo/db'
import { workspaceAppGrants } from '@plexo/db'
import { resolveEffectiveProfile, type Profile } from './resolve.js'

/** Master gate. Default OFF — enforcement only runs when explicitly enabled. */
export function isProfileEnforcementEnabled(): boolean {
    return process.env.PROFILE_ENFORCEMENT_ENABLED === 'true'
}

/**
 * Dev convenience (pre-mortem #2 fallback): bypass default-deny so local dev
 * isn't blocked before any grant exists. NEVER honored in production.
 */
export function isDevAutogrant(): boolean {
    return process.env.PLEXO_DEV_AUTOGRANT === '1' && process.env.NODE_ENV !== 'production'
}

/**
 * Load the operator-granted profile for an app in a workspace.
 * Returns null when no active 'granted' row exists (default-deny).
 */
export async function loadGrantedProfile(workspaceId: string, appId: string): Promise<Profile | null> {
    try {
        const [row] = await db
            .select({
                allowedConnectors: workspaceAppGrants.allowedConnectors,
                capabilities: workspaceAppGrants.capabilities,
                status: workspaceAppGrants.status,
            })
            .from(workspaceAppGrants)
            .where(and(
                eq(workspaceAppGrants.workspaceId, workspaceId),
                eq(workspaceAppGrants.appId, appId),
            ))
            .limit(1)
        if (!row || row.status !== 'granted') return null
        return {
            connectors: row.allowedConnectors ?? [],
            capabilities: row.capabilities ?? [],
        }
    } catch {
        // Fail-closed under enforcement is handled by the caller treating null as
        // EMPTY_PROFILE; a DB read error therefore denies rather than leaks.
        return null
    }
}

/**
 * Resolve the profile to ENFORCE for a tool-load, or null when enforcement does
 * not apply (caller should then allow-all — the current behavior).
 *
 * Returns null (skip enforcement) when:
 *   - no appId on the task (interactive / cron / dashboard tasks)
 *   - PROFILE_ENFORCEMENT_ENABLED is not 'true' (default OFF)
 *   - dev autogrant is on (local dev convenience, never prod)
 *
 * Otherwise returns the effective profile. No per-call request is available at
 * tool-load, so effective = the full operator grant; a missing grant resolves to
 * EMPTY_PROFILE (deny-all).
 */
export async function resolveEnforcedProfile(workspaceId: string, appId?: string): Promise<Profile | null> {
    if (!appId) return null
    if (!isProfileEnforcementEnabled()) return null
    if (isDevAutogrant()) return null
    const granted = await loadGrantedProfile(workspaceId, appId)
    return resolveEffectiveProfile(granted)
}
