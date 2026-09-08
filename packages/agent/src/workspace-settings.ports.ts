// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace AI-settings persistence port (Stage 3, providers cluster).
 *
 * `providers/settings-from-instances.ts` turns a workspace's provider rows
 * into the `WorkspaceAISettings` the routers consume; this port abstracts the
 * reads and the two balance-exhaustion writes. The drizzle adapter
 * (`workspace-settings.repository.ts`) is the only settings module permitted
 * to import the ORM. Key decryption, the short-TTL cache, the routing-chain
 * assembly and every skip rule stay in the use case — the port moves rows,
 * not routing policy.
 */

import type { ProviderCapabilities } from './provider-discovery.ports.js'

/**
 * The `provider_instances` columns the settings build reads. Hand-declared, so
 * a schema column added tomorrow does not silently widen what routing sees.
 */
export interface SettingsInstanceRow {
    id: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    capabilities: ProviderCapabilities
    managed: boolean
    enabled: boolean
    selectedModel: string | null
    balanceExhaustedAt: Date | null
}

/** One provider type currently marked funds-depleted in a workspace. */
export interface BalanceExhaustedRow {
    providerType: string
    nickname: string
    exhaustedAt: Date | null
}

/** The workspace's pinned quality-judge model, when it has set one. */
export interface JudgeModelSelection {
    provider: string
    model: string
}

export interface WorkspaceSettingsStore {
    /**
     * Every provider instance in a workspace, ordered by `preferenceOrder`
     * ascending. Unfiltered: which rows are routable is a use-case decision.
     */
    listInstances(workspaceId: string): Promise<SettingsInstanceRow[]>
    /**
     * `workspaces.intelligence_settings.judgeModel`, or `null` when the
     * workspace has not pinned one (including a partial value, which is not a
     * usable selection). Rejects on a read failure.
     */
    getJudgeModel(workspaceId: string): Promise<JudgeModelSelection | null>
    /**
     * Stamp `balanceExhaustedAt` on every instance of `providerType` in the
     * workspace whose flag is still NULL, so the first-seen time survives
     * repeated failures. Returns how many rows were newly marked.
     *
     * Deliberately not filtered by `enabled` — that matches the query this
     * replaced, whose own doc comment said "enabled" while the SQL never
     * checked it. Preserved as-is rather than corrected here; changing which
     * rows get flagged is a routing decision, not a port extraction.
     */
    markBalanceExhausted(workspaceId: string, providerType: string, at: Date): Promise<number>
    /** Clear the flag for a provider type (operator dismissal → re-arm). */
    clearBalanceExhausted(workspaceId: string, providerType: string): Promise<void>
    /** Instances currently carrying the flag, for the site-wide notice. */
    listBalanceExhausted(workspaceId: string): Promise<BalanceExhaustedRow[]>
}
