// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { BootConfig, GoldenRecord, ConceptAttractor, DomainRegion } from './types.js'
import { generateId } from './utils/id.js'
import { centroid } from './utils/vector.js'

export function boot(config: BootConfig): GoldenRecord {
    const now = Date.now()
    const rootRegionId = generateId()

    const attractors: ConceptAttractor[] = config.spiritAnchors.map(anchor => ({
        id: generateId(),
        position: anchor.position,
        regionId: rootRegionId,
        type: anchor.type,
        depthClass: 'spirit',
        salience: 1.0,
        driftProtected: true,
        label: anchor.label,
        mutationCount: 0,
        lastMutatedAt: now,
    }))

    const positions = config.spiritAnchors.map(a => a.position)
    const rootCentroid = positions.length > 0 ? centroid(positions) : []

    const rootRegion: DomainRegion = {
        id: rootRegionId,
        label: 'root',
        centroid: rootCentroid,
        radius: 1.0,
        density: attractors.length,
        children: [],
    }

    return {
        id: generateId(),
        version: 'scl/1.0',
        workspaceId: config.workspaceId,
        regions: [rootRegion],
        attractors,
        transformations: [],
        ledgerRefs: [],
        bootedAt: now,
        lastMutatedAt: now,
    }
}
