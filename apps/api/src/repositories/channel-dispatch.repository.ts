// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel-dispatch app-profile data-access repository.
 *
 * arch-findings B1 — owns the app_profiles existence lookup behind the
 * dispatch auth gate. The route keeps the in-process TTL cache and the
 * bearer-token handling.
 */
import { db, eq } from '@plexo/db'
import { appProfiles } from '@plexo/db'

/** True when an app profile with this id is registered. */
export async function appExists(appId: string): Promise<boolean> {
    const [row] = await db.select({ appId: appProfiles.appId })
        .from(appProfiles).where(eq(appProfiles.appId, appId)).limit(1)
    return !!row
}
