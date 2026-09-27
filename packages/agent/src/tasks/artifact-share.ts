// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { DrizzleArtifactShareStore } from '../tasks.repository.js'
import type { ArtifactShareStore } from '../tasks.ports.js'

// ── Composition root + test seam ────────────────────────────────────────────
let store: ArtifactShareStore = new DrizzleArtifactShareStore()

/** Swap the artifact-share store (e.g. an in-memory fake in unit tests). */
export function setArtifactShareStore(next: ArtifactShareStore): void {
    store = next
}

// The human-facing share PAGE is served by the WEB app (e.g. https://<app-host>/s/<id>),
// NOT the api origin. PUBLIC_URL points at the api host, whose /s/<id> 404s.
// Prefer an explicit app URL, fall back to the auth URL (same app origin), then
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
        const reuse = await store.findActiveShareId(artifactId)
        if (reuse) return `${APP_URL}/s/${reuse}`

        const shareId = generateShareId()
        await store.insertShareIfAbsent({
            id: shareId,
            artifactId,
            workspaceId,
            createdBy: 'agent-auto',
            visibility,
        })

        // Re-read to resolve the winner under the active-share unique index
        // (covers the onConflictDoNothing race where another writer won).
        const after = await store.findActiveShareId(artifactId)
        return after ? `${APP_URL}/s/${after}` : null
    } catch {
        return null
    }
}
