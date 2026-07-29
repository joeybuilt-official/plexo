// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared policy-layer types. Phase 4 of `graphiti-migration/plan.md`.
 *
 * The policy module enforces three independent gates around Plexo's memory
 * surface, all introduced fresh in Phase 4 (Explore audit confirmed there is
 * no legacy partial impl on `memory_entries.app_id` to preserve):
 *
 *   1. cross-app-filter — DENY-by-default reads across app boundaries
 *   2. rate-limit       — combined per-app + per-workspace token bucket
 *   3. quarantine       — Pex namespace + trust-tiered trial durations
 *
 * Telemetry signals are stubbed here (`signals.ts`); real Pex signals land
 * with the Pex framework design and replace the no-op emitter.
 */

/** A retrieved Graphiti edge with the policy-relevant attributes the schema-mapping doc reserves. */
export interface PolicyEdge {
    uuid: string | null
    fact: string | null
    /** From the edge attributes dict. Present on edges written via Phase 5+ ingest. */
    callerApp: string | null
    /** Optional — only present for facts attributed to a specific user. */
    plexoUserId: string | null
    valid_at: string | null
    invalid_at: string | null
    created_at: string | null
}

/** Identity of the caller making a memory-layer request. */
export interface PolicyCaller {
    appId: string
    userId?: string | null
    workspaceId: string
}

/** Trust tier — drives trial duration in `quarantine.ts`. */
export type TrustTier = 'signed' | 'unverified' | 'new'
