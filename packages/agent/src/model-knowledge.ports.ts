// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model-knowledge persistence port (Stage 3, providers cluster).
 *
 * `providers/knowledge.ts` pulls the Portkey model registry and stores what it
 * learns; this port is the store half. The drizzle adapter
 * (`model-knowledge.repository.ts`) is the only knowledge module permitted to
 * import the ORM. Fetching, the provider allowlist, and every mapping from
 * Portkey's untyped JSON to a record stay in the use case — the port takes
 * finished records.
 */

/** One `models_knowledge` row, as the sync produces it. */
export interface ModelKnowledgeRecord {
    /** `${provider}/${modelId}` — the conflict target. */
    id: string
    provider: string
    modelId: string
    contextWindow: number
    /** Dollars per million input tokens. */
    costPerMIn: number
    /** Dollars per million output tokens. */
    costPerMOut: number
    strengths: string[]
    lastSyncedAt: Date
}

export interface ModelKnowledgeStore {
    /**
     * Upsert every record, replacing pricing, context window, strengths and the
     * sync timestamp on conflict. How the write is batched, and the A6
     * real+numeric dual-write, are the adapter's business. An empty list is a
     * no-op. Rejects on a write failure.
     */
    upsertAll(records: ModelKnowledgeRecord[]): Promise<void>
}
