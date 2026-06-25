// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3 — Extraction Pipeline
 *
 * Fire-and-forget fact extractor called from conversation-bridge after each
 * turn. Replaces the SCL Golden Record mutation path with direct writes to
 * memory_entries using the Phase 1 structured columns.
 *
 * Called as: void extractTurn({...}).catch(logger.warn)
 * Must not add latency to the conversation response path.
 */

import pino from 'pino'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { memoryEntries } from '@plexo/db'
import { emitMemoryExtraction, emitMemoryEmbedded } from '../analytics/memory-events.js'

const logger = pino({ name: 'extract-worker' })

// ADR 0004: keep this schema minimal so small models (gpt-oss-120b on
// groq/cerebras/ollama) reliably satisfy strict structured-output validation.
//  - `.nullable()` not `.optional()` — strict providers reject optional
//    (omitted-from-`required`) properties ("invalid JSON schema: required must
//    include domain").
//  - NO maxLength / numeric-bound constraints — small models exceed them and
//    strict mode hard-rejects the whole generation ("Failed to validate JSON").
//    We validate loosely here and truncate/clamp in the consumer before the DB
//    write (which carries the real length limits).
const FactSchema = z.object({
    facts: z.array(z.object({
        factType: z.enum(['identity', 'preference', 'skill', 'context', 'constraint']),
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        domain: z.string().nullable(),
        confidence: z.number(),
    })),
})

const EXTRACT_SYSTEM = `You are a memory extraction API. Extract 0-3 durable, reusable facts from the conversation.
State facts in third person and be specific (e.g. "user lives in Austin" not "I live in Austin").
Ignore greetings, one-time status, and ephemeral content.
Return {"facts":[]} if nothing durable is worth storing.`

export async function extractTurn(params: {
    workspaceId: string
    userMessage: string
    assistantReply: string
    sessionId: string
    source: string
}): Promise<void> {
    const { workspaceId, userMessage, assistantReply, sessionId, source } = params

    if (userMessage.length < 20) return

    try {
        const { callModel } = await import('../providers/call-model.js')
        const { resolveModelFromEnv } = await import('../providers/registry.js')
        const { loadSettingsFromInstances } = await import('../providers/settings-from-instances.js')
        const { routeAndCall } = await import('../providers/router-v2/index.js')
        const { embed } = await import('./store.js')

        let aiSettings: Awaited<ReturnType<typeof loadSettingsFromInstances>> = null
        try {
            aiSettings = await loadSettingsFromInstances(workspaceId)
        } catch {
            aiSettings = null
        }

        const doCall = (model: Parameters<typeof callModel>[0]['model']) => callModel({
            model,
            provider: 'router-v2',
            system: EXTRACT_SYSTEM,
            messages: [{
                role: 'user',
                content: `User: ${userMessage.slice(0, 400)}\nAssistant: ${assistantReply.slice(0, 400)}`,
            }],
            maxTokens: 250,
            schema: FactSchema,
            schemaName: 'Facts',
            schemaDescription: 'Durable facts extracted from a conversation turn.',
        })

        let extracted: Awaited<ReturnType<typeof doCall>> | null = null
        if (aiSettings) {
            try {
                extracted = await routeAndCall({ workspaceId, taskType: 'summarization', settings: aiSettings, doCall })
            } catch (err) {
                logger.warn({ err, workspaceId }, 'extract-worker: routeAndCall failed — env fallback')
            }
        }
        if (!extracted) {
            // ADR 0004: routeAndCall exhausted (e.g. the workspace's only models
            // are small ones that can't satisfy the extraction schema, and
            // deepseek is out of balance). The env fallback throws NO_PROVIDER in
            // the inngest context (no system-wide key) — fact extraction is
            // non-critical memory enrichment, so degrade cleanly instead of
            // raising a noisy error.
            try {
                extracted = await doCall(resolveModelFromEnv())
            } catch {
                logger.info({ workspaceId, source }, 'extract-worker: no extraction provider could satisfy the schema — skipping (non-fatal)')
                emitMemoryExtraction({ workspaceId, factsExtracted: 0, factsWritten: 0, source, sessionId })
                return
            }
        }
        const { object: parsed } = extracted

        if (!parsed.facts.length) {
            emitMemoryExtraction({ workspaceId, factsExtracted: 0, factsWritten: 0, source, sessionId })
            return
        }

        const { getWriteBackend, shouldWritePostgres, shouldMirrorGraphiti, mirrorToGraphiti } = await import('./write-backend.js')
        const backend = getWriteBackend()

        let factsWritten = 0
        for (const rawFact of parsed.facts.slice(0, 3)) {
            // ADR 0004: length/range limits live here (not in the strict schema)
            // so small models can't hard-fail generation on them. Truncate to the
            // DB column limits + clamp confidence to 0..1.
            const fact = {
                factType: rawFact.factType,
                subject: rawFact.subject.slice(0, 100),
                predicate: rawFact.predicate.slice(0, 100),
                object: rawFact.object.slice(0, 300),
                domain: rawFact.domain ? rawFact.domain.slice(0, 60) : null,
                confidence: Math.min(1, Math.max(0, Number(rawFact.confidence) || 0)),
            }
            const content = `${fact.subject} ${fact.predicate} ${fact.object}`
            const id = crypto.randomUUID()

            if (shouldWritePostgres(backend)) {
                await db.insert(memoryEntries).values({
                    id,
                    workspaceId,
                    type: 'pattern',
                    content,
                    factType: fact.factType,
                    subject: fact.subject,
                    predicate: fact.predicate,
                    object: fact.object,
                    domain: fact.domain ?? null,
                    sourceText: userMessage.slice(0, 500),
                    source,
                    scopeLevel: 'workspace',
                    confidence: fact.confidence,
                    metadata: { session_id: sessionId, extracted_at: new Date().toISOString() },
                    namespace: 'default',
                    tier: 'active',
                })

                // Pattern rows must land with embeddings — mirrors the storeMemory
                // pattern/note embedding floor so vector search never sees nulls.
                // Skipped in graphiti-only mode: the sidecar's add_episode handles
                // its own embedding pipeline against the workspace's inference URL.
                const embedStart = Date.now()
                const vector = await embed(content, workspaceId, aiSettings ?? undefined).catch(() => null)
                if (vector) {
                    const vecStr = `[${vector.join(',')}]`
                    await db.execute(
                        sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
                    )
                    emitMemoryEmbedded({ workspaceId, factId: id, dimensions: vector.length, latencyMs: Date.now() - embedStart })
                }
            }

            const hasChatProvider = aiSettings !== null && Object.keys(aiSettings.providers).length > 0
            if (shouldMirrorGraphiti(backend) && !hasChatProvider) {
                logger.info({ workspaceId }, 'extract-worker: skipping graphiti mirror — workspace has no chat provider')
            } else if (shouldMirrorGraphiti(backend)) {
                // Fire-and-forget; the helper never throws and emits its own
                // success/failure analytics. We don't await it because the
                // Inngest fn already runs in a step.run() boundary that owns
                // retry semantics for the postgres write — Graphiti errors
                // surface in the dashboards, not in fact-extraction failures.
                void mirrorToGraphiti({
                    workspaceId,
                    content,
                    sourceDescription: `app:plexo|src:${source}`,
                    name: `extract-${fact.factType}`,
                    triple: { subject: fact.subject, predicate: fact.predicate, object: fact.object },
                    metadata: {
                        session_id: sessionId,
                        fact_type: fact.factType,
                        domain: fact.domain ?? null,
                        confidence: fact.confidence,
                    },
                })
            }
            factsWritten++

            logger.info({ workspaceId, factType: fact.factType, subject: fact.subject, backend }, 'extract-worker: fact persisted')
        }
        emitMemoryExtraction({
            workspaceId,
            factsExtracted: parsed.facts.length,
            factsWritten,
            source,
            sessionId,
        })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'extract-worker: fact extraction failed (non-fatal)')
    }
}
