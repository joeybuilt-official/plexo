// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stabilization eval-results data-access repository.
 *
 * owns the eval_results reads (dashboard rollup) and the
 * eval-type-discriminated inserts (cycle / workload / fixer / proactive_agent /
 * conversation_quality). The route keeps the service-key guard, request
 * validation, metadata assembly, JSON.stringify, and response shaping. All
 * queries are raw `sql` over the eval_results table. Filters are parameterised.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Most-recent 'cycle' eval row. */
export async function getLatestCycle() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'cycle'
        ORDER BY created_at DESC
        LIMIT 1
    `)
}

/** Last 20 'cycle' eval rows. */
export async function getCycleHistory() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'cycle'
        ORDER BY created_at DESC
        LIMIT 20
    `)
}

/** Latest batch of 'workload' rows (all sharing the most-recent created_at). */
export async function getLatestWorkloads() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'workload'
          AND created_at = (
              SELECT MAX(created_at) FROM eval_results WHERE eval_type = 'workload'
          )
        ORDER BY metric_name
    `)
}

/** Latest SCL eval metrics (retrieval / promotion / drift). */
export async function getSclEval() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type IN ('scl_retrieval', 'scl_promotion', 'scl_drift')
        ORDER BY created_at DESC
        LIMIT 20
    `)
}

/** Latest fixer dispatches. */
export async function getFixerActivity() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'fixer'
        ORDER BY created_at DESC
        LIMIT 20
    `)
}

/** Open findings (no resolved flag in metadata). */
export async function getOpenFindings() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'finding'
          AND (metadata->>'resolved') IS NULL
        ORDER BY created_at DESC
        LIMIT 50
    `)
}

/** Latest proactive-agent activity. */
export async function getProactiveAgents() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'proactive_agent'
        ORDER BY created_at DESC
        LIMIT 20
    `)
}

/** Latest conversation-quality evals. */
export async function getConversationQuality() {
    return db.execute(sql`
        SELECT * FROM eval_results
        WHERE eval_type = 'conversation_quality'
        ORDER BY created_at DESC
        LIMIT 10
    `)
}

/** Insert a conversation_quality eval row. */
export async function insertConversationQuality(
    wsId: string, metricName: string, metricValue: number, metadataJson: string, createdAtIso: string,
): Promise<void> {
    await db.execute(sql`
        INSERT INTO eval_results (workspace_id, eval_type, metric_name, metric_value, metadata, created_at)
        VALUES (${wsId}::uuid, 'conversation_quality', ${metricName}, ${metricValue}, ${metadataJson}::jsonb, ${createdAtIso}::timestamptz)
    `)
}

/** Insert a fixer (fix-dispatch) eval row. */
export async function insertFixDispatch(
    wsId: string, metricName: string, metricValue: number, metadataJson: string, createdAtIso: string,
): Promise<void> {
    await db.execute(sql`
        INSERT INTO eval_results (workspace_id, eval_type, metric_name, metric_value, metadata, created_at)
        VALUES (${wsId}::uuid, 'fixer', ${metricName}, ${metricValue}, ${metadataJson}::jsonb, ${createdAtIso}::timestamptz)
    `)
}

/** Insert a proactive_agent eval row. */
export async function insertProactiveAgent(
    wsId: string, metricName: string, metricValue: number, metadataJson: string, createdAtIso: string,
): Promise<void> {
    await db.execute(sql`
        INSERT INTO eval_results (workspace_id, eval_type, metric_name, metric_value, metadata, created_at)
        VALUES (${wsId}::uuid, 'proactive_agent', ${metricName}, ${metricValue}, ${metadataJson}::jsonb, ${createdAtIso}::timestamptz)
    `)
}

/** Insert a regular stabilization 'cycle' eval row. */
export async function insertCycle(
    wsId: string, metricName: string, metricValue: number, metadataJson: string, createdAtIso: string,
): Promise<void> {
    await db.execute(sql`
        INSERT INTO eval_results (workspace_id, eval_type, metric_name, metric_value, metadata, created_at)
        VALUES (${wsId}::uuid, 'cycle', ${metricName}, ${metricValue}, ${metadataJson}::jsonb, ${createdAtIso}::timestamptz)
    `)
}

/** Insert a single 'workload' eval row. */
export async function insertWorkload(
    wsId: string, metricName: string, metricValue: number, metadataJson: string, createdAtIso: string,
): Promise<void> {
    await db.execute(sql`
        INSERT INTO eval_results (workspace_id, eval_type, metric_name, metric_value, metadata, created_at)
        VALUES (${wsId}::uuid, 'workload', ${metricName}, ${metricValue}, ${metadataJson}::jsonb, ${createdAtIso}::timestamptz)
    `)
}
