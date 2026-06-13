// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Graphiti shadow re-extraction (Round-5 Phase 3, ADR 0001).
 *
 * The operator chose ground-truth shadow re-extraction over the cheap
 * downstream proxy: to measure whether a D2 candidate model degrades graphiti
 * extraction quality, re-run the SAME episode on the candidate and compare its
 * output to the primary's. Proxy-only graphiti calls have no task/judge row, so
 * this is the only quality signal that gates the Phase-4 flip for that path.
 *
 * Cost is bounded three ways so the over-budget-workspace concern (Felix) only
 * materializes when the operator explicitly opts in for an eval window:
 *   1. default OFF — `PLEXO_SHADOW_EXTRACTION_RATE` defaults to 0.
 *   2. sampled    — only `rate` fraction of eligible calls fire a shadow call.
 *   3. scoped     — background apps + schema-mode (extraction) only.
 *
 * Fire-and-forget: a thrown error here never touches the primary response.
 */

import pino from 'pino'
import * as shadowExtractionRepo from '../repositories/shadow-extraction.repository.js'
import { callModel } from '@plexo/agent/providers/call-model'
import { routeAndCall } from '@plexo/agent/providers/router-v2'
import type { WorkspaceAISettings } from '@plexo/agent/providers/registry'

const logger = pino({ name: 'inference:shadow-extraction' })

/** Candidate model to evaluate. Falls back to the D2 model so a single env
 *  can drive both the flip and its pre-flight shadow eval. */
function shadowModel(): string | undefined {
    const m = process.env.PLEXO_SHADOW_EXTRACTION_MODEL?.trim()
        || process.env.PLEXO_INFERENCE_BG_MODEL?.trim()
    return m && m !== '' ? m : undefined
}

function sampleRate(): number {
    const r = Number(process.env.PLEXO_SHADOW_EXTRACTION_RATE ?? 0)
    return Number.isFinite(r) && r > 0 ? Math.min(1, r) : 0
}

/** Jaccard token overlap on the JSON-serialized extraction outputs (0..1).
 *  Cheap, deterministic, no embedding spend — the cost we bound is the shadow
 *  inference call, not the scoring. */
function agreement(a: string, b: string): number {
    const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
    const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
    if (ta.size === 0 && tb.size === 0) return 1
    let inter = 0
    for (const t of ta) if (tb.has(t)) inter++
    const union = new Set([...ta, ...tb]).size
    return union > 0 ? inter / union : 0
}

/** Count extracted items: sum of array lengths + scalar/object leaf fields.
 *  A strongly negative (shadow − primary) delta = the candidate is dropping
 *  entities/edges, the regression signal. */
function countFields(obj: unknown): number {
    if (obj == null) return 0
    if (Array.isArray(obj)) return obj.reduce((n: number, v) => n + countFields(v), 0)
    if (typeof obj === 'object') return Object.values(obj as Record<string, unknown>).reduce((n: number, v) => n + countFields(v), 0)
    return 1
}

export interface ShadowExtractionArgs {
    appId: string | undefined
    workspaceId: string
    aiSettings: WorkspaceAISettings
    system: string | undefined
    conversational: Array<{ role: 'user' | 'assistant'; content: string }>
    /** Runtime Zod schema produced by jsonSchemaToZod. */
    zodSchema: unknown
    schemaName: string | undefined
    schemaDescription: string | undefined
    maxTokens: number | undefined
    /** The model that served the primary extraction (for the comparison row). */
    primaryModel: string
    /** The primary extraction output object. */
    primaryObject: unknown
}

/** Decide-and-run. Returns immediately; the shadow call (if any) runs detached.
 *  Caller must have already confirmed this is a background-app request. */
export function maybeShadowExtraction(args: ShadowExtractionArgs): void {
    const rate = sampleRate()
    if (rate <= 0 || Math.random() >= rate) return
    const candidate = shadowModel()
    if (!candidate || candidate === args.primaryModel) return
    void runShadow(args, candidate)
}

async function runShadow(args: ShadowExtractionArgs, candidate: string): Promise<void> {
    try {
        const shadowResult = await routeAndCall({
            workspaceId: args.workspaceId,
            taskType: 'extraction',
            settings: args.aiSettings,
            laneOverride: 'background',
            modelIdOverride: candidate,
            doCall: (model) => callModel<unknown>({
                model,
                provider: (model as { provider?: string }).provider ?? 'unknown',
                workspaceId: args.workspaceId,
                taskType: 'inference.chat.completions',
                system: args.system,
                messages: args.conversational,
                maxTokens: args.maxTokens,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime Zod schema
                schema: args.zodSchema as any,
                schemaName: args.schemaName,
                schemaDescription: args.schemaDescription,
            }),
        })

        const shadowObject = shadowResult && typeof shadowResult === 'object' && 'object' in shadowResult
            ? (shadowResult as { object: unknown }).object
            : shadowResult
        const shadowModelUsed = (shadowResult as { model?: string })?.model ?? candidate

        const score = agreement(JSON.stringify(args.primaryObject), JSON.stringify(shadowObject))
        const primaryFields = countFields(args.primaryObject)
        const shadowFields = countFields(shadowObject)

        await shadowExtractionRepo.insertShadowResult({
            workspaceId: args.workspaceId,
            appId: args.appId ?? null,
            primaryModel: args.primaryModel,
            shadowModel: shadowModelUsed,
            agreementScore: score,
            primaryFieldCount: primaryFields,
            shadowFieldCount: shadowFields,
        })
        logger.debug({ workspaceId: args.workspaceId, candidate, score: score.toFixed(3), primaryFields, shadowFields }, 'shadow extraction logged')
    } catch (err) {
        logger.warn({ err, workspaceId: args.workspaceId, candidate }, 'shadow extraction failed — non-fatal')
    }
}
