// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Jex identity-mesh application ports (ADR-0016 B3).
 *
 * Plexo is the identity COORDINATOR on the Jex mesh — never the root. These
 * interfaces invert the dependency on infrastructure: the use-cases depend on
 * `JexRecognitionRepository`, and the drizzle adapter implements it. Only the
 * domain vocabulary below crosses the boundary — never drizzle rows.
 *
 * The wire contract is fixed by the client already shipping in Nexalog
 * (PlexoCoordinator, _eval/nexalog/lib/identity/coordinator.ts): a recognition
 * is { appId, userId, email, credentialId }; a canonical profile is
 * { userId, email, name, apps }.
 */

/** An app reporting that it recognized a mesh identity via a passkey credential. */
export interface RecognitionInput {
    appId: string
    userId: string
    email: string
    credentialId: string
}

/** Mesh-wide canonical profile aggregated across every app that recognized the user. */
export interface CanonicalProfile {
    userId: string
    email: string
    name: string
    /** Every appId that has recorded a recognition for this user. */
    apps: string[]
}

/** Persistence of cross-app recognitions, in domain terms. */
export interface JexRecognitionRepository {
    /** Idempotent upsert of a recognition, keyed (appId, userId, credentialId). */
    record(input: RecognitionInput): Promise<void>
    /** Canonical profile for a user, or null when the identity is unknown. */
    getProfile(userId: string): Promise<CanonicalProfile | null>
}
