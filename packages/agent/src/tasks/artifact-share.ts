// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { eq, and, isNull } from 'drizzle-orm'
import { db, artifactShares } from '@plexo/db'

// The human-facing share PAGE is served by the WEB app (e.g. app.getplexo.com/s/<id>),
// NOT the api origin. PUBLIC_URL points at the api (api.getplexo.com), whose /s/<id>
// 404s. Prefer an explicit app URL, fall back to the auth URL (same app origin), then
// PUBLIC_URL as a last resort.
const APP_URL = process.env.APP_PUBLIC_URL || process.env.BETTER_AUTH_URL || process.env.PUBLIC_URL || 'http://localhost:3000'

/**
 * Auto-share visibility policy (Phase Q), `PLEXO_AUTO_SHARE_VISIBILITY`:
 *  - 'off'      → never auto-mint a share (returns null; no URL surfaced)
 *  - 'unlisted' → link-only, not publicly listed/indexed (DEFAULT)
 *  - 'public'   → publicly listed
 * Operator-tunable without a redeploy. Anything else falls back to 'unlisted'.
 */
export function autoShareVisibility(): 'off' | 'unlisted' | 'public' {
    const v = process.env.PLEXO_AUTO_SHARE_VISIBILITY?.toLowerCase()
    return v === 'off' || v === 'public' ? v : 'unlisted'
}

function generateShareId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Idempotently ensure an auto-minted share for an artifact and return its public
 * URL — e.g. so a produced playable HTML asset yields a `${APP_URL}/s/<id>` link
 * the user can open. Visibility honors `PLEXO_AUTO_SHARE_VISIBILITY` (default
 * unlisted; `off` disables auto-minting entirely). Best-effort: never throws
 * (returns null on any failure). Mirrors the create logic in
 * apps/api/src/routes/shares.ts (one active share per artifact, enforced by the
 * `artifact_shares_active_uq` unique index).
 */
export async function ensureArtifactShareUrl(artifactId: string, workspaceId: string): Promise<string | null> {
    const visibility = autoShareVisibility()
    if (visibility === 'off') return null
    try {
        const reuse = await db.select({ id: artifactShares.id })
            .from(artifactShares)
            .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
            .limit(1)
        if (reuse[0]) return `${APP_URL}/s/${reuse[0].id}`

        const shareId = generateShareId()
        await db.insert(artifactShares).values({
            id: shareId,
            artifactId,
            workspaceId,
            createdBy: 'agent-auto',
            visibility,
        }).onConflictDoNothing()

        // Re-read to resolve the winner under the active-share unique index
        // (covers the onConflictDoNothing race where another writer won).
        const after = await db.select({ id: artifactShares.id })
            .from(artifactShares)
            .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
            .limit(1)
        return after[0] ? `${APP_URL}/s/${after[0].id}` : null
    } catch {
        return null
    }
}
