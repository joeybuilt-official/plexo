// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model-catalog data-access repository (read-only).
 *
 * owns the models_knowledge reads. The route keeps row
 * shaping, filtering, sorting, pagination, and recommendation logic.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

const CATALOG_COLS = sql`id, provider, model_id, context_window, cost_per_m_in,
               cost_per_m_out, strengths, reliability_score, last_synced_at`

/** Full model catalog ordered by provider, model_id. */
export async function listCatalogOrdered() {
    return db.execute(sql`
        SELECT ${CATALOG_COLS}
        FROM models_knowledge
        ORDER BY provider, model_id
    `)
}

/** Full model catalog, unordered (recommendation endpoint). */
export async function listCatalog() {
    return db.execute(sql`
        SELECT ${CATALOG_COLS}
        FROM models_knowledge
    `)
}
