// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §24 — LLM Identity & Model Context
 * Kapsel Protocol Specification v0.3.0
 *
 * When an Agent acts, the LLM powering it must be visible to the audit trail,
 * the user, and the system. Different models produce different decisions from
 * the same Agent — making logs incomplete, behavior non-reproducible, and
 * user consent uninformed.
 *
 * Rules:
 *   - If localModelAcceptable: false and host resolves to a cloud provider,
 *     the Agent's dataResidency MUST list that provider as an external destination
 *   - If host policy prohibits external model calls, Agents declaring
 *     localModelAcceptable: false MUST be rejected at install
 *   - Hosts MUST surface which model powers each active Agent in admin UI
 *   - Model changes require user re-acknowledgment for Agents with
 *     IRREVERSIBLE_ACTION escalation triggers
 *   - Capability token: model:override — required for Agents that dynamically
 *     select their own model at runtime
 */

// ---------------------------------------------------------------------------
// Manifest: modelRequirements field
// ---------------------------------------------------------------------------

export interface ModelRequirements {
    minimumContextWindow?: number
    requiresFunctionCalling?: boolean
    localModelAcceptable?: boolean
    prohibitedProviders?: string[]
    preferredProviders?: string[]
}

// ---------------------------------------------------------------------------
// Audit Ledger: modelContext block (added to every AuditEntry)
// ---------------------------------------------------------------------------

export interface ModelContextEntry {
    /** e.g. 'claude-sonnet-4-5', 'llama-3.3-70b' */
    modelId: string
    /** Exact version or hash if self-hosted */
    modelVersion?: string
    /** e.g. 'anthropic', 'openai', 'ollama', 'self-hosted' */
    modelProvider: string
    /** true if on-host, false if external API */
    isLocal: boolean
    /** Tokens used in this call */
    contextWindowUsed?: number
}
