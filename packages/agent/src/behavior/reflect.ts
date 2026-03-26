// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Post-task reflection — promotes successful execution patterns into
 * domain_knowledge behavior rules so the agent learns from outcomes.
 *
 * Unique index: behavior_rules_ws_key ON (workspace_id, key) WHERE deleted_at IS NULL
 * — confirmed present via migration 0033_reflection_index.sql.
 *
 * NOTE (audit): The prompt specified a notes.slice() change in memory/store.ts,
 * but no such slice exists in that file. recordTaskMemory uses notes inline
 * without slicing. Skipped per audit protocol.
 */

import pino from 'pino'
import { generateText } from 'ai'
import { db, sql } from '@plexo/db'
import { resolveModelFromEnv } from '../providers/registry.js'

const logger = pino({ name: 'behavior.reflect' })

export interface ReflectCtx {
    workspaceId: string
    taskId: string
    goal: string
    taskType: string
    toolsUsed: string[]
    qualityScore: number
    outcomeSummary: string
    stepCount: number
    durationMs: number
}

interface Observation {
    key: string
    label: string
    insight: string
}

/**
 * Reflect on a completed task and promote reusable strategy observations
 * into the behavior_rules table as domain_knowledge entries.
 */
export async function reflectAndPromote(ctx: ReflectCtx): Promise<void> {
    // ── Gate 1: workspace setting ─────────────────────────────────────────
    try {
        const rows = await db.execute<{ value: unknown }>(sql`
            SELECT value FROM workspace_preferences
            WHERE workspace_id = ${ctx.workspaceId}::uuid
              AND key = 'reflection_enabled'
        `)
        const enabled = rows[0]?.value
        if (enabled !== true && enabled !== 'true') return
    } catch {
        // Query failed — default to disabled
        return
    }

    // ── Gate 2: quality threshold ─────────────────────────────────────────
    if (ctx.qualityScore < 0.8) return

    // ── Gate 3: summary length ────────────────────────────────────────────
    if (!ctx.outcomeSummary || ctx.outcomeSummary.length < 50) return

    // ── LLM call ──────────────────────────────────────────────────────────
    const model = resolveModelFromEnv()  // cheap/fast model (defaults to summarization tier)

    let observations: Observation[]
    try {
        const { text } = await generateText({
            model,
            system: `You extract reusable strategy observations from completed tasks. Respond with a raw JSON array only — no preamble, no markdown fences. Format: [{ "key": string, "label": string, "insight": string }]. Keys must be snake_case, prefixed reflect.<taskType>.<shortname>. Return 1-3 observations. Each insight should be a concise, actionable principle (1-2 sentences).`,
            messages: [{
                role: 'user',
                content: `Task type: ${ctx.taskType}\nGoal: ${ctx.goal}\nOutcome: ${ctx.outcomeSummary}\nTools used: ${ctx.toolsUsed.join(', ')}\nSteps: ${ctx.stepCount}\nDuration: ${ctx.durationMs}ms`,
            }],
            // @ts-expect-error maxTokens exists in AI SDK v6 but type inference misses it
            maxTokens: 300,
        })

        observations = JSON.parse(text.trim())
    } catch (err) {
        logger.warn({ err, taskId: ctx.taskId }, 'Reflection LLM call or JSON parse failed')
        return
    }

    if (!Array.isArray(observations)) return

    // ── Upsert loop ───────────────────────────────────────────────────────
    for (const obs of observations) {
        if (!obs.key || !obs.insight || typeof obs.key !== 'string') continue

        try {
            // ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL DO UPDATE
            // Anti-collapse: if existing value already has 3+ separators, skip.
            await db.execute(sql`
                INSERT INTO behavior_rules
                    (id, workspace_id, type, key, label, description, value, source, tags)
                VALUES
                    (gen_random_uuid(), ${ctx.workspaceId}::uuid,
                     'domain_knowledge', ${obs.key}, ${obs.label || obs.key}, '',
                     ${JSON.stringify({ type: 'text_block', value: obs.insight })}::jsonb,
                     'reflection',
                     ${sql`ARRAY['auto', ${ctx.taskType}]::text[]`})
                ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
                DO UPDATE SET
                    value = CASE
                        WHEN (
                            length(behavior_rules.value->>'value')
                            - length(replace(behavior_rules.value->>'value', '---', ''))
                        ) / 3 >= 3
                        THEN behavior_rules.value
                        ELSE jsonb_set(
                            behavior_rules.value,
                            '{value}',
                            to_jsonb(
                                (behavior_rules.value->>'value') || E'\n---\n' || ${obs.insight}
                            )
                        )
                    END,
                    updated_at = now()
            `)
        } catch (err) {
            logger.warn({ err, taskId: ctx.taskId, key: obs.key }, 'Reflection upsert failed')
        }
    }
}
