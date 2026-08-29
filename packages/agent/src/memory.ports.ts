// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory persistence port — batches 1-2 of the memory-port extraction
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * `corrections.ts`, `conversation-bridge.ts`, `extract-worker.ts`,
 * `preferences.ts`, and `ab-variants.ts` depend on these abstractions; the
 * drizzle adapters in `memory.repository.ts` are the only place that touch
 * the ORM. Records are plain, fully-resolved shapes — no drizzle types
 * cross here.
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

export interface PreferenceRecord {
    key: string
    value: unknown
    confidence: number
}

export interface PreferenceUpsertInput {
    workspaceId: string
    key: string
    value: unknown
    confidence: number
}

export interface PreferenceStore {
    /** All preferences for a workspace, ordered by confidence desc. */
    listByWorkspace(workspaceId: string): Promise<PreferenceRecord[]>
    /** A single preference value, or null when absent. */
    getValue(workspaceId: string, key: string): Promise<unknown | null>
    /**
     * Insert a preference, or merge an observation into the existing row:
     * confidence moves toward 0.95, evidence_count increments.
     */
    upsert(record: PreferenceUpsertInput): Promise<void>
}

export interface ImprovementLogChallenger {
    id: string
    proposedChange: string
    metadata: unknown
}

export interface VariantOutcome {
    variant: 'A' | 'B'
    qualityScore: number
}

export interface ImprovementLogStore {
    /** Most recent unapplied, non-discarded challenger of the given pattern type. */
    selectPendingChallenger(workspaceId: string, patternType: string): Promise<ImprovementLogChallenger | null>
    /** Append one {variant, qualityScore} sample into metadata.variants. */
    appendVariantOutcome(id: string, outcome: VariantOutcome): Promise<void>
    /** Re-read the current metadata for a log entry. */
    getMetadata(id: string): Promise<unknown | null>
    /** Mark a challenger as discarded (metadata.discarded = true). */
    markDiscarded(id: string): Promise<void>
    /** The proposed_change payload for a log entry, or null when absent. */
    getProposedChange(id: string): Promise<string | null>
    /** Mark a challenger applied via auto-promotion (applied = true, metadata.auto_promoted = true). */
    markAutoPromoted(id: string): Promise<void>
}
