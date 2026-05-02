// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Domain Mastery — Credit Assignment (ADR-003).
 *
 * On task completion, looks up learning_events whose source_ref matches any
 * rule in the context_hash. Uses lift metric (Panel 5) not raw
 * correlation. Applies confidence decay and rule quarantine.
 *
 * All operations are feature-flagged via credit_assignment_enabled and
 * domain_mastery_enabled workspace preferences.
 *
 * Kill switch: if domain quality avg drops below learning_quality_floor
 * for learning_regression_windows consecutive measurement periods,
 * learning_kill_switch_triggered is set to true (ADR-004).
 */

import pino from 'pino'
import {
    MIN_CREDIT_OCCURRENCES,
    MIN_QUALITY_DELTA,
    LIFT_BENEFICIAL,
    LIFT_HARMFUL,
    MAX_RULES_PER_WORKSPACE,
    MAX_RULES_PER_DOMAIN,
} from './index.js'

const logger = pino({ name: 'domain-mastery:credit' })

/**
 * Record credit for learning events that were in context for a completed task.
 * Called from the executor after quality scoring.
 *
 * @param workspaceId - The workspace ID.
 * @param contextHash - The context hash from the task's system prompt.
 * @param contextRuleKeys - The rule keys that were in the prompt.
 * @param qualityScore - The quality score for the completed task.
 * @param domainTag - The inferred domain tag for the task.
 */
export async function recordCredit(opts: {
    workspaceId: string
    contextHash: string | null
    contextRuleKeys: string[]
    qualityScore: number
    domainTag: string | null
}): Promise<void> {
    if (!opts.contextHash || opts.contextRuleKeys.length === 0) return

    try {
        const { db, sql } = await import('@plexo/db')

        // Find learning_events whose source_ref matches any rule key in context
        // and tag them with quality context. This builds the dataset for lift calc.
        for (const ruleKey of opts.contextRuleKeys) {
            void db.execute(sql`
                INSERT INTO learning_events
                    (workspace_id, domain_tag, event_type, source_surface,
                     source_ref, quality_context, context_hash)
                VALUES
                    (${opts.workspaceId}::uuid, ${opts.domainTag},
                     'credit_observation', 'credit-assignment.ts',
                     ${ruleKey}, ${opts.qualityScore}, ${opts.contextHash})
            `).catch(() => { /* fire-and-forget */ })
        }
    } catch (err) {
        logger.warn({ err, workspaceId: opts.workspaceId }, 'Credit recording failed')
    }
}

/**
 * Check kill switch: if quality below floor for N consecutive windows,
 * disable learning for the workspace (ADR-004).
 */
export async function checkKillSwitch(workspaceId: string): Promise<boolean> {
    try {
        const { db, sql } = await import('@plexo/db')

        // Read kill switch config from workspace preferences
        const configRows = await db.execute<{ key: string; value: unknown }>(sql`
            SELECT key, value FROM workspace_preferences
            WHERE workspace_id = ${workspaceId}::uuid
              AND key IN ('learning_quality_floor', 'learning_regression_windows',
                          'learning_kill_switch_triggered', 'domain_mastery_enabled')
        `)

        const config: Record<string, unknown> = {}
        for (const row of configRows) config[row.key] = row.value

        // Already triggered? Skip.
        if (config.learning_kill_switch_triggered === true) return true
        if (config.domain_mastery_enabled !== true) return false

        const floor = typeof config.learning_quality_floor === 'number'
            ? config.learning_quality_floor : 0.4
        const windows = typeof config.learning_regression_windows === 'number'
            ? config.learning_regression_windows : 3

        // Check last N weekly periods for below-floor quality
        const metricsRows = await db.execute<{ avg_quality: number }>(sql`
            SELECT avg_quality FROM plexo_ops_domain_metrics
            WHERE workspace_id = ${workspaceId}::uuid
              AND avg_quality IS NOT NULL
            ORDER BY period_start DESC
            LIMIT ${windows}
        `)

        if (metricsRows.length < windows) return false // Not enough data

        const allBelowFloor = metricsRows.every(r => r.avg_quality < floor)
        if (!allBelowFloor) return false

        // Trigger kill switch
        logger.warn({ workspaceId, floor, windows }, 'Learning kill switch triggered — quality below floor')

        await db.execute(sql`
            INSERT INTO workspace_preferences (workspace_id, key, value)
            VALUES (${workspaceId}::uuid, 'learning_kill_switch_triggered', 'true'::jsonb)
            ON CONFLICT (workspace_id, key) DO UPDATE SET value = 'true'::jsonb, last_updated = NOW()
        `)

        // Emit plexo_ops signal
        await db.execute(sql`
            INSERT INTO plexo_ops_analytics (app, event_name, properties, instance_uuid)
            VALUES ('plexo', 'learning_regression_detected',
                    ${JSON.stringify({ workspace_id: workspaceId, floor, windows })}::jsonb,
                    'domain-mastery')
        `).catch(() => { /* fire-and-forget */ })

        return true
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Kill switch check failed')
        return false
    }
}

/**
 * Confidence decay: mark behavior rules as stale if they haven't been credited
 * (appeared in context for a quality > 0.7 task) in 60 days (Panel 6).
 *
 * Should be called from a weekly cron job.
 */
export async function decayStaleRules(workspaceId: string): Promise<{ staleCount: number }> {
    try {
        const { db, sql } = await import('@plexo/db')

        // Find reflection-sourced rules that haven't been in a credit observation
        // for 60+ days. Mark them by adding 'stale' to tags.
        const result = await db.execute<{ count: number }>(sql`
            UPDATE behavior_rules
            SET tags = array_append(tags, 'stale'),
                updated_at = NOW()
            WHERE workspace_id = ${workspaceId}::uuid
              AND source = 'reflection'
              AND deleted_at IS NULL
              AND NOT ('stale' = ANY(tags))
              AND key NOT IN (
                  SELECT DISTINCT source_ref FROM learning_events
                  WHERE workspace_id = ${workspaceId}::uuid
                    AND event_type = 'credit_observation'
                    AND quality_context >= 0.7
                    AND created_at > NOW() - INTERVAL '60 days'
                    AND source_ref IS NOT NULL
              )
              AND updated_at < NOW() - INTERVAL '60 days'
            RETURNING id
        `)

        const staleCount = Array.isArray(result) ? result.length : 0
        if (staleCount > 0) {
            logger.info({ workspaceId, staleCount }, 'Marked stale reflection rules')
        }

        return { staleCount }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Confidence decay failed')
        return { staleCount: 0 }
    }
}

/**
 * Rule quarantine: if a rule is in context for 3+ below-average tasks in a row,
 * add 'quarantined' to its tags (Pre-mortem Failure Mode 1).
 */
export async function quarantinePoorRules(workspaceId: string): Promise<{ quarantinedCount: number }> {
    try {
        const { db, sql } = await import('@plexo/db')

        // Find rules with 3+ recent credit observations where quality < 0.5
        const result = await db.execute<{ source_ref: string }>(sql`
            SELECT source_ref FROM (
                SELECT source_ref,
                       quality_context,
                       ROW_NUMBER() OVER (PARTITION BY source_ref ORDER BY created_at DESC) as rn
                FROM learning_events
                WHERE workspace_id = ${workspaceId}::uuid
                  AND event_type = 'credit_observation'
                  AND source_ref IS NOT NULL
                  AND quality_context IS NOT NULL
                  AND created_at > NOW() - INTERVAL '30 days'
            ) recent
            WHERE rn <= 3
            GROUP BY source_ref
            HAVING COUNT(*) >= 3 AND AVG(quality_context) < 0.5
        `)

        const toQuarantine = Array.isArray(result) ? result.map(r => r.source_ref) : []
        let quarantinedCount = 0

        if (toQuarantine.length > 0) {
            await db.execute(sql`
                UPDATE behavior_rules
                SET tags = array_append(tags, 'quarantined'),
                    updated_at = NOW()
                WHERE workspace_id = ${workspaceId}::uuid
                  AND key = ANY(${toQuarantine}::text[])
                  AND deleted_at IS NULL
                  AND NOT ('quarantined' = ANY(tags))
            `).catch(() => null)
            quarantinedCount = toQuarantine.length
        }

        if (quarantinedCount > 0) {
            logger.info({ workspaceId, quarantinedCount }, 'Quarantined poor-performing rules')
        }

        return { quarantinedCount }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Rule quarantine failed')
        return { quarantinedCount: 0 }
    }
}

/**
 * Refresh domain metrics for a workspace (cron-driven, weekly).
 * Computes per-domain quality averages and learning event counts.
 */
export async function refreshDomainMetrics(workspaceId: string): Promise<void> {
    try {
        const { db, sql } = await import('@plexo/db')

        // Compute weekly aggregates from work_ledger + learning_events
        await db.execute(sql`
            INSERT INTO plexo_ops_domain_metrics
                (workspace_id, domain_tag, period_start, avg_quality, task_count,
                 learning_event_count, quality_delta)
            SELECT
                wl.workspace_id,
                wl.domain_tag,
                date_trunc('week', wl.completed_at)::date as period_start,
                AVG(wl.quality_score) as avg_quality,
                COUNT(*)::integer as task_count,
                COALESCE(le.le_count, 0)::integer as learning_event_count,
                AVG(wl.quality_score) - LAG(AVG(wl.quality_score)) OVER (
                    PARTITION BY wl.workspace_id, wl.domain_tag
                    ORDER BY date_trunc('week', wl.completed_at)
                ) as quality_delta
            FROM work_ledger wl
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::integer as le_count
                FROM learning_events le2
                WHERE le2.workspace_id = wl.workspace_id
                  AND le2.domain_tag = wl.domain_tag
                  AND le2.created_at >= date_trunc('week', wl.completed_at)
                  AND le2.created_at < date_trunc('week', wl.completed_at) + INTERVAL '7 days'
            ) le ON true
            WHERE wl.workspace_id = ${workspaceId}::uuid
              AND wl.domain_tag IS NOT NULL
              AND wl.quality_score IS NOT NULL
              AND wl.completed_at > NOW() - INTERVAL '90 days'
            GROUP BY wl.workspace_id, wl.domain_tag, date_trunc('week', wl.completed_at), le.le_count
            ON CONFLICT (workspace_id, domain_tag, period_start)
            DO UPDATE SET
                avg_quality = EXCLUDED.avg_quality,
                task_count = EXCLUDED.task_count,
                learning_event_count = EXCLUDED.learning_event_count,
                quality_delta = EXCLUDED.quality_delta
        `)

        logger.debug({ workspaceId }, 'Domain metrics refreshed')
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Domain metrics refresh failed')
    }
}
