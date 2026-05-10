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
import { db, sql } from '@plexo/db'
import { memoryEntries } from '@plexo/db'
import { emitMemoryExtraction, emitMemoryEmbedded } from '../analytics/memory-events.js'

const logger = pino({ name: 'extract-worker' })

const FactSchema = z.object({
    facts: z.array(z.object({
        factType: z.enum(['identity', 'preference', 'skill', 'context', 'constraint']),
        subject: z.string().max(100),
        predicate: z.string().max(100),
        object: z.string().max(300),
        domain: z.string().max(60).optional(),
        confidence: z.number().min(0).max(1),
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
        const { resolveModel, resolveModelFromEnv } = await import('../providers/registry.js')
        const { loadSettingsFromInstances } = await import('../providers/settings-from-instances.js')
        const { embed } = await import('./store.js')

        let model: ReturnType<typeof resolveModelFromEnv>
        let provider = 'env-fallback'
        let aiSettings: Awaited<ReturnType<typeof loadSettingsFromInstances>> = null

        try {
            aiSettings = await loadSettingsFromInstances(workspaceId)
            if (aiSettings) {
                const resolved = await resolveModel('summarization', aiSettings, workspaceId)
                model = resolved.model
                provider = resolved.meta.provider
            } else {
                model = resolveModelFromEnv()
            }
        } catch {
            model = resolveModelFromEnv()
        }

        const { object: parsed } = await callModel({
            model,
            provider,
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

        if (!parsed.facts.length) {
            emitMemoryExtraction({ workspaceId, factsExtracted: 0, factsWritten: 0, source, sessionId })
            return
        }

        const { getWriteBackend, shouldWritePostgres, shouldMirrorGraphiti, mirrorToGraphiti } = await import('./write-backend.js')
        const backend = getWriteBackend()

        let factsWritten = 0
        for (const fact of parsed.facts.slice(0, 3)) {
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

            if (shouldMirrorGraphiti(backend)) {
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
