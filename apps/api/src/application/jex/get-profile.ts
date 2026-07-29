// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Use-case: read the mesh-wide canonical profile for a user (ADR-0016 B3).
 * Returns null when the identity is unknown — the edge maps that to 404.
 */

import type { CanonicalProfile, JexRecognitionRepository } from './ports.js'

export function makeGetProfile(repo: JexRecognitionRepository) {
    return function getProfile(userId: string): Promise<CanonicalProfile | null> {
        return repo.getProfile(userId)
    }
}

export type GetProfile = ReturnType<typeof makeGetProfile>
