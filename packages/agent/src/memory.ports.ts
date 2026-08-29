// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory persistence port — batches 1-3 of the memory-port extraction
 * (docs/claude/platform/memory-port-extraction/plan.md).
 *
 * `corrections.ts`, `conversation-bridge.ts`, `extract-worker.ts`,
 * `preferences.ts`, `ab-variants.ts`, `prompt-improvement.ts`, and
 * `self-improvement.ts` depend on these abstractions; the drizzle adapters
 * in `memory.repository.ts` are the only place that touch the ORM. Records
 * are plain, fully-resolved shapes — no drizzle types cross here.
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

export interface ImprovementProposalInput {
    patternType: string
    description: string
    evidence: unknown
    proposedChange: string | null
}

export interface ImprovementLogProposal {
    proposedChange: string
    applied: boolean
}

export interface ImprovementLogEntry {
    id: string
    patternType: string
    description: string
    evidence: unknown
    proposedChange: string | null
    applied: boolean
    createdAt: Date
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
    /** Insert one or more improvement proposals in a single multi-row statement. */
    appendProposals(workspaceId: string, proposals: ImprovementProposalInput[]): Promise<void>
    /** A log entry's proposed_change + applied flag, scoped to a workspace. */
    getProposalForWorkspace(workspaceId: string, id: string): Promise<ImprovementLogProposal | null>
    /** Mark a log entry applied (applied = true), with no metadata change. */
    markApplied(id: string): Promise<void>
    /** Most recent log entries for a workspace, newest first. */
    listRecent(workspaceId: string, limit: number): Promise<ImprovementLogEntry[]>
}

export interface WorkLedgerPromptSample {
    taskId: string | null
    type: string
    qualityScore: number | null
    calibration: string | null
    tokensIn: number | null
    deliverables: unknown
    wallClockMs: number | null
}

export interface WorkLedgerOutcomeSample {
    taskId: string | null
    type: string
    qualityScore: number | null
    confidenceScore: number | null
    calibration: string | null
    tokensIn: number | null
    tokensOut: number | null
    deliverables: unknown
    wallClockMs: number | null
    completedAt: Date | null
}

export interface TaskOutcomeSample {
    id: string
    type: string
    qualityScore: number | null
    confidenceScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    outcomeSummary: string | null
    completedAt: Date | null
}

export interface WorkLedgerSampleStore {
    /** Most recent work-ledger rows for prompt-improvement analysis, newest first. */
    selectPromptSamples(workspaceId: string, limit: number): Promise<WorkLedgerPromptSample[]>
    /** Most recent work-ledger rows for self-improvement analysis, newest first. */
    selectOutcomeSamples(workspaceId: string, limit: number): Promise<WorkLedgerOutcomeSample[]>
    /** Fallback: completed tasks used when work-ledger history is sparse. */
    selectTaskOutcomeSamples(workspaceId: string, limit: number): Promise<TaskOutcomeSample[]>
}

/** One task memory eligible to be folded into a weekly summary. */
export interface ConsolidationCandidate {
    id: string
    content: string
    createdAt: Date
}

/** The summary row that replaces a batch of individual memories. */
export interface ConsolidationWrite {
    workspaceId: string
    content: string
    metadata: Record<string, unknown>
    /** Dated to the oldest memory in the batch, so a later pass still skips it. */
    createdAt: Date
    /** Exactly the memories whose content is inside `content`. */
    replaceIds: string[]
}

export interface MemoryConsolidationStore {
    /** How many task memories have not yet been folded into a summary. */
    countUnconsolidated(workspaceId: string): Promise<number>
    /** Un-consolidated task memories created before `before`, oldest first. */
    listUnconsolidatedBefore(
        workspaceId: string,
        before: Date,
        limit: number,
    ): Promise<ConsolidationCandidate[]>
    /**
     * Insert the summary and delete the memories it replaces.
     *
     * This is ONE method on purpose. Splitting it into `insert()` and
     * `deleteMany()` would lose the atomicity the single data-modifying CTE
     * gives it today: a crash between the two halves would either duplicate
     * the memories or destroy them with no summary to show for it.
     * Implementations must perform both in one statement or one transaction.
     */
    consolidateInto(write: ConsolidationWrite): Promise<void>
}
