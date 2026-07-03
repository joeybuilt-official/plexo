// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Use-case: record that an app recognized a mesh identity (ADR-0016 B3).
 * Normalizes the email to canonical form (trim + lowercase) before persisting,
 * so the same identity from two apps aggregates cleanly. The upsert itself is
 * idempotent — replaying the same recognition is a no-op beyond bumping seenAt.
 */

import type { JexRecognitionRepository, RecognitionInput } from './ports.js'

export function makeRecordRecognition(repo: JexRecognitionRepository) {
    return function recordRecognition(input: RecognitionInput): Promise<void> {
        return repo.record({ ...input, email: input.email.trim().toLowerCase() })
    }
}

export type RecordRecognition = ReturnType<typeof makeRecordRecognition>
