// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Onboarding canary — a scheduled synthetic check that the new-user
 * first-workspace path still works, so a regression is caught even while
 * public sign-ups are disabled.
 *
 * Background: the real onboarding break (a 500 on POST /api/v1/workspaces)
 * happened entirely inside the workspace-creation transaction — the FDW
 * `public.users` mirror raised on `ON CONFLICT`, aborting the tx — and was
 * invisible because public sign-ups were off. This canary re-runs that exact
 * transaction (mirror → workspace insert → owner membership) for a dedicated,
 * pre-provisioned canary user and then ROLLS BACK, so:
 *   - it exercises the precise statements that failed (incl. the FDW mirror),
 *   - nothing is ever persisted (no cleanup, no orphan workspaces),
 *   - no auth users are created/churned (sign-up path stays closed).
 *
 * It covers the DB layer where the break occurred. The HTTP/auth/session layer
 * is exercised continuously by real traffic; a commit-only failure mode (e.g. a
 * deferred constraint) would not be caught by the rollback — acceptable given
 * prod `public.users` is an FDW foreign table with no local constraints.
 *
 * OFF by default. Enable by setting BOTH:
 *   PLEXO_ONBOARDING_CANARY=1
 *   PLEXO_ONBOARDING_CANARY_USER_ID=<uuid of a dedicated auth user>
 */

import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, workspaceMembers, DEFAULT_WORKSPACE_SETTINGS, DEFAULT_INTELLIGENCE_SETTINGS } from '@plexo/db'
import { mirrorAuthUserToPublic, type AuthUserPayload } from '@plexo/db/auth/config'
import { logger } from './logger.js'
import { emitCanaryResult } from './analytics/events.js'
import { recordCanaryFailureForAlert } from './ops-alerts.js'

/** Thrown to force the canary transaction to roll back after it succeeds. */
class CanaryRollback extends Error {}

export function onboardingCanaryEnabled(): boolean {
    return process.env.PLEXO_ONBOARDING_CANARY === '1' && Boolean(process.env.PLEXO_ONBOARDING_CANARY_USER_ID)
}

export async function runOnboardingCanary(): Promise<void> {
    const canaryUserId = process.env.PLEXO_ONBOARDING_CANARY_USER_ID
    if (!canaryUserId) return
    const started = Date.now()

    try {
        // The canary user must already exist in public.users (auth.user via FDW
        // on prod). We never create it here — provisioning is an operator step.
        const rows = await db.execute(sql`
            SELECT id, name, email, "emailVerified", "createdAt", "updatedAt"
            FROM public.users WHERE id = ${canaryUserId}::uuid LIMIT 1
        `) as unknown as Array<Record<string, unknown>>
        const u = rows[0]
        if (!u) {
            logger.error(
                { canary: 'onboarding', canaryUserId },
                '[onboarding-canary] canary user not found in public.users — provision it or unset PLEXO_ONBOARDING_CANARY_USER_ID',
            )
            // Misconfiguration, not a regression — surface as an analytics signal
            // but don't feed the operator alert (would be a standing false alarm).
            emitCanaryResult({ check: 'onboarding', ok: false, durationMs: Date.now() - started })
            return
        }

        const payload: AuthUserPayload = {
            id: String(u.id),
            name: String(u.name ?? 'Onboarding Canary'),
            email: String(u.email),
            emailVerified: Boolean(u.emailVerified),
            createdAt: u.createdAt as string | Date,
            updatedAt: u.updatedAt as string | Date,
        }

        await db.transaction(async (tx) => {
            // Same sequence as POST /api/v1/workspaces (apps/api/src/routes/workspaces.ts).
            await mirrorAuthUserToPublic(payload, tx)
            const [ws] = await tx.insert(workspaces).values({
                name: '__onboarding_canary__',
                ownerId: canaryUserId,
                settings: DEFAULT_WORKSPACE_SETTINGS,
                intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
            }).returning({ id: workspaces.id })
            if (!ws) throw new Error('workspace insert returned no row')
            await tx.insert(workspaceMembers).values({
                workspaceId: ws.id,
                userId: canaryUserId,
                role: 'owner',
            }).onConflictDoNothing()
            // Success — abort so nothing persists.
            throw new CanaryRollback()
        }).catch((err: unknown) => {
            if (!(err instanceof CanaryRollback)) throw err
        })

        logger.info(
            { canary: 'onboarding', ms: Date.now() - started },
            '[onboarding-canary] OK — new-user first-workspace path healthy',
        )
        emitCanaryResult({ check: 'onboarding', ok: true, durationMs: Date.now() - started })
    } catch (err) {
        logger.error(
            { err, canary: 'onboarding', ms: Date.now() - started },
            '[onboarding-canary] FAILED — new-user first-workspace creation is broken',
        )
        emitCanaryResult({ check: 'onboarding', ok: false, durationMs: Date.now() - started })
        recordCanaryFailureForAlert({
            check: 'onboarding',
            reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
        })
    }
}
