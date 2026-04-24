// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL-aware reflection: converts task outcomes into Golden Record mutations.
 *
 * When scl_enabled=true, this runs INSTEAD OF the text-based reflection.
 * The LLM produces structured concepts and relations instead of text rules.
 * These are parsed into a MutationInput and applied to the Golden Record.
 */

import pino from 'pino'
import { z } from 'zod'
import { db, sql } from '@plexo/db'
import { mutate } from '@plexo/scl-core'
import type { MutationInput, DriftWarning, ConceptType, RelationType } from '@plexo/scl-core'
import { resolveModelFromEnv } from '../providers/registry.js'
import { loadGoldenRecord, saveGoldenRecord, loadSclMutationConfig } from './storage.js'
import type { ReflectCtx } from '../behavior/reflect.js'

const logger = pino({ name: 'scl:reflect' })

// ── Structured output schema for the LLM ─────────────────────────────────────
//
// Phase 4: Zod schema drives `generateObject` via callModel. The SDK
// validates the output and retries on malformed shape before surfacing
// CALL_MODEL_PARSE. `ConceptType` / `RelationType` are loose strings here
// because the actual enum sets live in `@plexo/scl-core` and the mutate()
// call downstream tolerates unknown types (it just drops them). Keeping
// the schema lenient avoids over-rejecting borderline-valid outputs from
// smaller models — the downstream `conceptsWithPositions.length === 0`
// gate is the real safety net.

const SclConceptSchema = z.object({
    label: z.string().min(1),
    type: z.string(),
    supersedes: z.string().optional(),
})

const SclRelationSchema = z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    relation: z.string(),
    confidence: z.number(),
})

const SclReflectionSchema = z.object({
    concepts: z.array(SclConceptSchema).default([]),
    relations: z.array(SclRelationSchema).default([]),
})

type SclReflectionOutput = {
    concepts: Array<{ label: string; type: ConceptType; supersedes?: string }>
    relations: Array<{ source: string; target: string; relation: RelationType; confidence: number }>
}

const SCL_REFLECT_SYSTEM = `You are an SCL knowledge extractor. Given a completed task, extract structured knowledge as concepts and relations.

Respond with ONLY valid JSON: { "concepts": [...], "relations": [...] }

Each concept: { "label": string (concise, 2-6 words), "type": "entity"|"event"|"state"|"claim"|"action"|"property", "supersedes": optional string (label of concept this replaces) }

Each relation: { "source": string (label), "target": string (label), "relation": "CAUSES"|"ENABLES"|"REQUIRES"|"SUPPORTS"|"PRODUCES"|"PERFORMS"|"HAS_PROPERTY"|"IS_A", "confidence": 0.0-1.0 }

Rules:
- Extract 1-5 concepts maximum
- Focus on reusable patterns, not task-specific details
- Prefer action/state/property types for operational knowledge
- Only include relations between concepts you extracted
- Confidence reflects how certain this pattern is`

/**
 * Run SCL-aware reflection on a completed task.
 * Extracts structured concepts/relations and mutates the Golden Record.
 */
export async function reflectAndMutate(
    ctx: ReflectCtx,
    embeddingProvider: { embed(text: string): Promise<number[]> },
): Promise<{
    mutated: boolean
    driftWarnings: DriftWarning[]
    attractorsRefined: number
    attractorsCreated: number
    ghostsArchived: number
}> {
    const record = await loadGoldenRecord(ctx.workspaceId)
    if (!record) {
        logger.warn({ workspaceId: ctx.workspaceId }, 'SCL reflect: no Golden Record — skipping')
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    // Quality gate: any task with quality >= 0.5 contributes to the lattice.
    // Below 0.5 we still extract (as failure patterns) as long as we have a
    // meaningful outcome summary — the mutation itself is shaped by the
    // SUCCEEDED/FAILED label passed to the LLM extractor.
    if (typeof ctx.qualityScore === 'number' && ctx.qualityScore < 0.3) {
        logger.debug({ taskId: ctx.taskId, quality: ctx.qualityScore }, 'SCL reflect: quality too low — skipping')
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    if (!ctx.outcomeSummary || ctx.outcomeSummary.length < 30) {
        logger.debug({ taskId: ctx.taskId, len: ctx.outcomeSummary?.length ?? 0 }, 'SCL reflect: outcome summary too short — skipping')
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    // LLM extraction
    const model = resolveModelFromEnv() // cheap/fast
    let structured: SclReflectionOutput

    try {
        const qualityLabel = (ctx.qualityScore ?? 0) >= 0.7 ? 'SUCCEEDED' : 'FAILED'
        // Phase 4 hardening — schema-mode callModel. generateObject owns
        // parse + validate + retry; CALL_MODEL_PARSE surfaces here if the
        // model keeps producing malformed output after the SDK's internal
        // retry. No hand-rolled fence strip / JSON.parse.
        const { callModel } = await import('../providers/call-model.js')
        const { object } = await callModel({
            model,
            system: SCL_REFLECT_SYSTEM,
            messages: [{
                role: 'user',
                content: `Task ${qualityLabel} (quality: ${ctx.qualityScore})\nType: ${ctx.taskType}\nGoal: ${ctx.goal}\nOutcome: ${ctx.outcomeSummary}\nTools: ${(ctx.toolsUsed ?? []).join(', ')}\nSteps: ${ctx.stepCount}\nDuration: ${ctx.durationMs}ms`,
            }],
            maxTokens: 500,
            schema: SclReflectionSchema,
            schemaName: 'SclReflection',
            schemaDescription: 'Extracted concepts and relations from a completed task.',
        })

        // Cast via unknown because the schema's `type`/`relation` fields
        // are loose `z.string()` — the downstream mutate() call is the
        // authoritative filter for unknown ConceptType / RelationType.
        structured = object as unknown as SclReflectionOutput
    } catch (err) {
        logger.error({
            err,
            taskId: ctx.taskId,
            workspaceId: ctx.workspaceId,
        }, 'SCL reflection LLM call or schema validation failed')
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    if (!structured?.concepts?.length) {
        logger.warn({ taskId: ctx.taskId }, 'SCL reflection produced no concepts')
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    // Generate embeddings for extracted concepts
    const conceptsWithPositions: MutationInput['concepts'] = []
    for (const c of structured.concepts.slice(0, 5)) {
        try {
            const position = await embeddingProvider.embed(c.label)
            conceptsWithPositions.push({
                label: c.label,
                type: c.type,
                position,
                attributes: {
                    taskId: ctx.taskId,
                    taskType: ctx.taskType,
                    quality: ctx.qualityScore,
                    ...(c.supersedes ? { supersedes: c.supersedes } : {}),
                },
            })
        } catch (err) {
            logger.warn({ err, label: c.label }, 'Failed to embed concept — skipping')
        }
    }

    if (conceptsWithPositions.length === 0) {
        return { mutated: false, driftWarnings: [], attractorsRefined: 0, attractorsCreated: 0, ghostsArchived: 0 }
    }

    // Build mutation input
    const input: MutationInput = {
        source: `reflect:${ctx.taskId}`,
        concepts: conceptsWithPositions,
        relations: (structured.relations ?? []).slice(0, 10).map(r => ({
            sourceLabel: r.source,
            targetLabel: r.target,
            relation: r.relation,
            confidence: Math.max(0, Math.min(1, r.confidence)),
        })),
    }

    // Load workspace SCL config overrides (user-tuned thresholds from UI)
    const sclConfigOverride = await loadSclMutationConfig(ctx.workspaceId)

    // Apply mutation with workspace config overrides
    const result = mutate(record, input, sclConfigOverride)

    // Persist updated Golden Record
    await saveGoldenRecord(ctx.workspaceId, record)

    // Persist drift warnings
    if (result.driftWarnings.length > 0) {
        await storeDriftWarnings(ctx.workspaceId, result.driftWarnings)
    }

    logger.info({
        workspaceId: ctx.workspaceId,
        taskId: ctx.taskId,
        created: result.attractorsCreated,
        refined: result.attractorsRefined,
        ghosted: result.ghostsArchived.length,
        driftWarnings: result.driftWarnings.length,
        rules: result.rulesAdded + result.rulesRefined,
    }, 'SCL reflection mutation applied')

    // Domain mastery: write learning_event for SCL mutation (fire-and-forget)
    void db.execute(sql`
        INSERT INTO learning_events
            (workspace_id, domain_tag, event_type, source_surface, source_ref, quality_context)
        VALUES
            (${ctx.workspaceId}::uuid, NULL, 'scl_mutation', 'reflect-scl.ts',
             ${input.source}, ${ctx.qualityScore})
    `).catch(() => { /* learning_events are fire-and-forget */ })

    return {
        mutated: true,
        driftWarnings: result.driftWarnings,
        attractorsRefined: result.attractorsRefined,
        attractorsCreated: result.attractorsCreated,
        ghostsArchived: result.ghostsArchived.length,
    }
}

/**
 * Persist drift warnings to the database.
 */
async function storeDriftWarnings(workspaceId: string, warnings: DriftWarning[]): Promise<void> {
    for (const w of warnings) {
        try {
            await db.execute(sql`
                INSERT INTO scl_drift_warnings
                    (workspace_id, attractor_id, attractor_label, current_position,
                     proposed_position, semantic_distance, threshold, source, status)
                VALUES (
                    ${workspaceId}::uuid,
                    ${w.attractorId},
                    ${w.attractorLabel},
                    ${JSON.stringify(w.currentPosition)}::jsonb,
                    ${JSON.stringify(w.proposedPosition)}::jsonb,
                    ${w.semanticDistance},
                    ${w.threshold},
                    ${w.source},
                    ${w.status}
                )
            `)
        } catch (err) {
            logger.error({ err, attractorId: w.attractorId }, 'Failed to store drift warning')
        }
    }
}
