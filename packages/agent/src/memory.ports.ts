// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory persistence port — batch 1 of the memory-port extraction
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * `corrections.ts`, `conversation-bridge.ts`, and `extract-worker.ts` depend
 * on these abstractions; the drizzle adapters in `memory.repository.ts` are
 * the only place that touch the ORM. Records are plain, fully-resolved
 * shapes — no drizzle types cross here.
 */

export interface BehaviorRuleInput {
    workspaceId: string
    type: string
    key: string
    label: string
    description: string
    value: unknown
    source: string
    tags: string[]
}

export interface BehaviorRuleStore {
    /**
     * Insert a behavior rule. No-op when a live row (deleted_at IS NULL)
     * already occupies the (workspaceId, key) conflict target.
     */
    insertIfAbsent(record: BehaviorRuleInput): Promise<void>
    /**
     * Insert a behavior rule, or overwrite `value` + `updated_at` on the
     * existing live row at the (workspaceId, key) conflict target.
     */
    upsert(record: BehaviorRuleInput): Promise<void>
}

export interface MemoryEntryInput {
    id: string
    workspaceId: string
    type: string
    content: string
    factType: string
    subject: string
    predicate: string
    object: string
    domain: string | null
    sourceText: string
    source: string
    scopeLevel: string
    confidence: number
    metadata: Record<string, unknown>
    namespace: string
    tier: string
}

export interface MemoryEntryStore {
    /** Insert a memory entry row (embedding left unset). */
    insert(record: MemoryEntryInput): Promise<void>
    /** Set the pgvector embedding for an existing memory entry. */
    setEmbedding(id: string, embedding: number[]): Promise<void>
}
