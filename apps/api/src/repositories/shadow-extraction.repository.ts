// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shadow-extraction data-access repository (write-only).
 *
 * arch-findings B1 — owns the shadow_extraction_results write. The route keeps
 * sampling, the shadow model call, agreement scoring, and field counting.
 */
import { db, sql } from '@plexo/db'

/** One shadow-vs-primary comparison row. */
export async function insertShadowResult(args: {
    workspaceId: string
    appId: string | null
    primaryModel: string
    shadowModel: string
    agreementScore: number
    primaryFieldCount: number
    shadowFieldCount: number
}): Promise<void> {
    await db.execute(sql`
        INSERT INTO shadow_extraction_results
            (workspace_id, app_id, primary_model, shadow_model, agreement_score, primary_field_count, shadow_field_count)
        VALUES (
            ${args.workspaceId},
            ${args.appId},
            ${args.primaryModel},
            ${args.shadowModel},
            ${args.agreementScore},
            ${args.primaryFieldCount},
            ${args.shadowFieldCount}
        )
    `)
}
