// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cost-gate persistence port (ADR-0045 Phase 2).
 *
 * `cost-gate.ts` (the executor-side gate) depends on this abstraction for all
 * DB reads. The drizzle adapter (`cost-gate.repository.ts`) is the only place
 * that touches the ORM. Redis, caching, and the spend-snapshot assembly stay
 * in the use-case — the port returns plain numbers, never drizzle rows.
 */

export interface AgentIntelligenceSettings {
    inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override'
    costCeilingUsd?: number
    costCeilingMode?: 'soft_warn' | 'hard_block' | 'off'
}

/** Token totals + request count for a workspace this month. */
export interface TokenCounts {
    inputTokens: number
    outputTokens: number
    requests: number
}

/** Full month-to-date spend computed from the DB (priced + token totals). */
export interface FullSpend extends TokenCounts {
    pricedUsd: number
}

export interface CostGateRepository {
    /** The workspace's intelligence settings JSON (empty object when unset). */
    getIntelligenceSettings(workspaceId: string): Promise<AgentIntelligenceSettings>
    /** Token totals + request count since `monthStartIso` (reporting only). */
    getTokenCounts(workspaceId: string, monthStartIso: string): Promise<TokenCounts>
    /** Priced spend + token totals since `monthStartIso` (full DB computation). */
    getFullSpend(workspaceId: string, monthStartIso: string): Promise<FullSpend>
}
