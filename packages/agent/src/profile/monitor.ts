// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §3) — monitor-mode observation sink.
 *
 * While PROFILE_ENFORCEMENT_MODE=monitor, the tool-load bridges record what they
 * WOULD have excluded into profile_monitor_observations (durable, survives
 * container recreates). The App Grants UI reads these so the operator can seed
 * grants from real coverage gaps before switching to hard enforce.
 *
 * Strictly best-effort: a recording failure must NEVER break tool-load.
 */
import { db, sql } from '@plexo/db'
import { profileMonitorObservations } from '@plexo/db'

export interface MonitorItem {
    kind: 'connector' | 'capability'
    token: string
    extName?: string
}

export async function recordMonitorObservations(
    workspaceId: string,
    appId: string,
    items: MonitorItem[],
): Promise<void> {
    if (items.length === 0) return
    // Dedup within the batch — ON CONFLICT DO UPDATE cannot touch the same row
    // twice in one statement.
    const seen = new Set<string>()
    const rows = items
        .filter((i) => {
            const k = `${i.kind}:${i.token}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })
        .map((i) => ({ workspaceId, appId, kind: i.kind, token: i.token, extName: i.extName ?? null }))

    try {
        await db
            .insert(profileMonitorObservations)
            .values(rows)
            .onConflictDoUpdate({
                target: [
                    profileMonitorObservations.workspaceId,
                    profileMonitorObservations.appId,
                    profileMonitorObservations.kind,
                    profileMonitorObservations.token,
                ],
                set: {
                    // Literal table-qualified column (proven SQL) — avoids the
                    // column-object interpolation that silently failed the SET.
                    observedCount: sql`profile_monitor_observations.observed_count + 1`,
                    lastSeenAt: sql`now()`,
                },
            })
    } catch {
        // best-effort — monitor recording must never break tool-load
    }
}
