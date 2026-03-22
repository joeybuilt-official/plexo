// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §20 — Persistent UserSelf
 * Kapsel Protocol Specification v0.3.0
 *
 * A host-managed UserSelf graph readable by owner and verified Extensions
 * with field-level scoping. Persists across sessions and survives Extension uninstall.
 *
 * Rules:
 *   - UserSelf is host-owned — no Extension owns it
 *   - Extensions contribute via structured proposals: self.propose(...)
 *   - Host resolves conflicts (last-write, confidence-weighted, or user-confirmed)
 *   - Extensions read via self.read(fields[]) — field-level scoping
 *   - Capability tokens: self:read, self:write
 *   - Agents read UserSelf to personalize behavior across all their loaded Extensions
 */

export interface UserIdentity {
    name?: string
    timezone?: string
    locale?: string
    primaryEmail?: string
}

export interface UserCommunicationStyle {
    formality?: 'casual' | 'neutral' | 'formal'
    verbosity?: 'concise' | 'moderate' | 'detailed'
    preferredChannels?: string[]
}

export interface UserContext {
    summary: string
    lastUpdated: string  // ISO 8601
}

export type UserSelfField =
    | 'identity'
    | 'preferences'
    | 'relationships'
    | 'contexts'
    | 'communicationStyle'

export interface UserSelf {
    identity: UserIdentity
    /** Extensible, typed key-value preferences */
    preferences: Record<string, unknown>
    /** Person entity IDs, ranked by recency/frequency */
    relationships: string[]
    /** Named contexts: work, finance, health, etc. */
    contexts: Record<string, UserContext>
    communicationStyle: UserCommunicationStyle
}

export interface UserSelfProposal {
    field: UserSelfField
    /** Dot-path within the field, e.g. 'identity.timezone' */
    path?: string
    value: unknown
    /** Extension proposing this change */
    source: string
    /** 0–1 confidence in the proposed value */
    confidence: number
}

export type UserSelfConflictResolution = 'last-write' | 'confidence-weighted' | 'user-confirmed'
