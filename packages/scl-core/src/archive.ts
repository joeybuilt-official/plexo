// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { GoldenRecord, LedgerPointer } from './types.js'
import { generateId } from './utils/id.js'

export function archive(
    record: GoldenRecord,
    attractorId: string,
): { record: GoldenRecord; pointer: LedgerPointer } {
    const idx = record.attractors.findIndex(a => a.id === attractorId)
    if (idx === -1) {
        throw new Error(`Attractor ${attractorId} not found in record`)
    }

    const attractor = record.attractors[idx]!
    const pointer: LedgerPointer = {
        externalRef: generateId(),
        ghostLabel: attractor.label,
        archivedAt: Date.now(),
        positionAtArchival: [...attractor.position],
    }

    const newRecord: GoldenRecord = {
        ...record,
        attractors: [...record.attractors.slice(0, idx), ...record.attractors.slice(idx + 1)],
        ledgerRefs: [...record.ledgerRefs, pointer],
        lastMutatedAt: Date.now(),
    }

    return { record: newRecord, pointer }
}
