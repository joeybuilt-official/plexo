// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Conflict-aware atomic fact write for the Phase 1 memory system.
 *
 * writeFact() is the authoritative entry point for persisting structured
 * facts to memory_entries. Unlike storeMemory (unstructured content) and
 * extractTurn (fire-and-forget after a conversation turn), this function:
 *
 *  1. Looks up existing active facts with the same predicate in the workspace
 *  2. Classifies the relationship: UPDATE | SCOPE | NONE
 *     - UPDATE:  new fact supersedes old (temporal change, e.g. language switch)
 *     - SCOPE:   both facts are correct but apply to different domains
 *     - NONE:    no conflict; insert alongside existing
 *  3. On UPDATE: marks the old fact with invalid_at + superseded_by
 *  4. Inserts the new fact regardless of conflict outcome
 *
 * Immunity rule: a fact with is_anchored = true is never superseded by
 * automated extraction. The new fact is still written (NONE outcome) so
 * both survive.
 *
 * Exact-match shortcut: if predicate + object + domain all match, the
 * outcome is UPDATE without an LLM call (pure dedup).
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { memoryEntries } from '@plexo/db'
import { z } from 'zod'

const logger = pino({ name: 'memory:write' })

export type ConflictAction = 'UPDATE' | 'SCOPE' | 'NONE'

export interface WriteFactParams {
    workspaceId: string
    factType: 'identity' | 'preference' | 'skill' | 'context' | 'constraint'
    subject: string
    predicate: string
    object: string
    domain?: string
    confidence: number
    source: string
    scopeLevel?: string
    userId?: string
    namespace?: string
    /** When true, this fact is anchored and immune to supersession. */
    isAnchored?: boolean
}

export interface WriteFactResult {
    action: ConflictAction
    id: string
    supersededId?: string
}

interface ExistingFact {
    [key: string]: unknown
    id: string
    predicate: string
    object: string
    domain: string | null
    factType: string | null
    isAnchored: boolean
}

const ResolutionSchema = z.object({
    action: z.enum(['UPDATE', 'SCOPE', 'NONE']),
    rationale: z.string().optional(),
})

const RESOLVE_SYSTEM = `You are a memory conflict resolver. Compare two facts about the same user and return the relationship.

Rules:
- UPDATE: the new fact supersedes the old (a change over time, e.g. "uses Go" → "uses Rust")
- SCOPE: both facts are true but apply to different contexts (e.g. "tabs in Python" vs "spaces in JS")
- NONE: no conflict; the facts are unrelated or additive

Respond with JSON: { "action": "UPDATE" | "SCOPE" | "NONE" }`

/**
 * Classify the relationship between an incoming fact and an existing one.
 * Returns UPDATE/SCOPE/NONE. May call the LLM unless an exact-match or
 * anchored-immunity shortcut applies.
 */
export async function resolveConflict(
    incoming: { predicate: string; object: string; domain?: string; factType: string },
    existing: ExistingFact,
): Promise<ConflictAction> {
    // Anchored facts are immune — automated extraction cannot supersede them.
    if (existing.isAnchored) return 'NONE'

    // Exact match — same fact restated — dedup without LLM.
    const norm = (s: string) => s.toLowerCase().trim()
    if (
        norm(existing.predicate) === norm(incoming.predicate) &&
        norm(existing.object) === norm(incoming.object) &&
        (existing.domain ?? null) === (incoming.domain ?? null)
    ) {
        return 'UPDATE'
    }

    // LLM-assisted classification for ambiguous cases.
    try {
        const { callModel } = await import('../providers/call-model.js')
        const { resolveModelFromEnv } = await import('../providers/registry.js')
        const model = resolveModelFromEnv()

        const { object: parsed } = await callModel({
            model,
            provider: 'env-fallback',
            system: RESOLVE_SYSTEM,
            messages: [{
                role: 'user',
                content: [
                    `Old fact: subject ${incoming.predicate} ${existing.object}${existing.domain ? ` (domain: ${existing.domain})` : ''}`,
                    `New fact: subject ${incoming.predicate} ${incoming.object}${incoming.domain ? ` (domain: ${incoming.domain})` : ''}`,
                ].join('\n'),
            }],
            maxTokens: 80,
            schema: ResolutionSchema,
            schemaName: 'Resolution',
            schemaDescription: 'Conflict resolution decision.',
        })
        return parsed.action
    } catch (err) {
        logger.warn({ err }, 'resolveConflict: LLM call failed — defaulting to NONE')
        return 'NONE'
    }
}

/**
 * Write a structured fact to memory_entries with conflict resolution.
 */
export async function writeFact(params: WriteFactParams): Promise<WriteFactResult> {
    const {
        workspaceId,
        factType,
        subject,
        predicate,
        object,
        domain,
        confidence,
        source,
        scopeLevel = 'workspace',
        userId,
        namespace = 'default',
        isAnchored = false,
    } = params

    const newId = crypto.randomUUID()

    // Look up existing active facts with the same predicate in this workspace.
    const rows = await db.execute<ExistingFact>(sql`
        SELECT id, predicate, object, domain, fact_type AS "factType", is_anchored AS "isAnchored"
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND predicate = ${predicate}
          AND superseded_by IS NULL
          AND (invalid_at IS NULL OR invalid_at > NOW())
          ${userId ? sql`AND (user_id = ${userId}::uuid OR user_id IS NULL)` : sql``}
        ORDER BY created_at DESC
        LIMIT 5
    `)

    let action: ConflictAction = 'NONE'
    let supersededId: string | undefined

    for (const existing of rows) {
        const candidate = await resolveConflict({ predicate, object, domain, factType }, existing)
        if (candidate === 'UPDATE') {
            action = 'UPDATE'
            supersededId = existing.id
            // Mark old fact as superseded — insert new row first so FK is valid.
            break
        }
        if (candidate === 'SCOPE') {
            action = 'SCOPE'
            break
        }
    }

    const { getWriteBackend, shouldWritePostgres, shouldMirrorGraphiti, mirrorToGraphiti } = await import('./write-backend.js')
    const backend = getWriteBackend()

    if (shouldMirrorGraphiti(backend)) {
        void mirrorToGraphiti({
            workspaceId,
            content: `${subject} ${predicate} ${object}`,
            sourceDescription: `app:plexo|src:writeFact|action:${action}`,
            name: `fact-${factType}`,
            triple: { subject, predicate, object },
            metadata: {
                fact_type: factType,
                domain: domain ?? null,
                confidence,
                source,
                scope_level: scopeLevel,
                user_id: userId ?? null,
                namespace,
                is_anchored: isAnchored,
                superseded_id: supersededId,
            },
        })
    }

    if (shouldWritePostgres(backend)) {
        // Insert the new fact.
        await db.insert(memoryEntries).values({
            id: newId,
            workspaceId,
            type: 'pattern',
            content: `${subject} ${predicate} ${object}`,
            factType,
            subject,
            predicate,
            object,
            domain: domain ?? null,
            confidence,
            source,
            scopeLevel,
            userId: userId ?? null,
            namespace,
            isAnchored,
            tier: 'active',
            metadata: { written_by: 'write.ts', action },
        })

        // If UPDATE: invalidate the old fact now that the new row exists.
        if (action === 'UPDATE' && supersededId) {
            await db.execute(sql`
                UPDATE memory_entries
                SET invalid_at = NOW(),
                    superseded_by = ${newId}::uuid
                WHERE id = ${supersededId}::uuid
            `)
            logger.info({ workspaceId, supersededId, newId }, 'write: fact superseded')
        }
    }

    return { action, id: newId, supersededId }
}
