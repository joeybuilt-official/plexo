// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL Cross-App Events + Namespace Isolation
 *
 * Apps write knowledge to the Golden Record with their namespace.
 * Any app can read, only the source app can mutate its own namespace.
 * Events carry stimuli (embedding vectors) for expansion, not raw data.
 */

import { expand, mutate } from '@plexo/scl-core'
import type { MutationInput, ExpansionResult } from '@plexo/scl-core'
import { loadGoldenRecord, saveGoldenRecord, isSclEnabled } from './storage.js'
import pino from 'pino'

const logger = pino({ name: 'scl:cross-app' })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CrossAppEvent {
    sourceApp: string
    eventType: string
    stimulus: number[]
    resolution: 'L0' | 'L1'
    payload?: Record<string, unknown>
}

export interface NamespacedMutationInput extends MutationInput {
    namespace: string
}

// ── Namespace Enforcement ─────────────────────────────────────────────────────

/**
 * Apply a namespaced mutation to the Golden Record.
 * Attractors and regions created by the app are tagged with the namespace.
 * Only concepts within the app's namespace can be refined — others are rejected.
 */
export async function mutateWithNamespace(
    workspaceId: string,
    input: NamespacedMutationInput,
): Promise<{ ok: boolean; error?: string }> {
    if (!(await isSclEnabled(workspaceId))) {
        return { ok: false, error: 'SCL not enabled' }
    }

    const record = await loadGoldenRecord(workspaceId)
    if (!record) return { ok: false, error: 'No Golden Record' }

    // Namespace enforcement: prevent an app from refining attractors it doesn't own.
    // Namespace is tracked per-attractor (not per-region) so each app's concepts
    // remain isolated regardless of which region they land in.
    // Attractors without a namespace (boot-time spirit anchors, legacy records) are
    // treated as 'core' — globally readable and mutable by any app.
    for (const concept of input.concepts) {
        const existing = record.attractors.find(a => a.label === concept.label)
        if (existing) {
            const existingNs = existing.namespace ?? 'core'
            if (existingNs !== input.namespace && existingNs !== 'core') {
                logger.warn({
                    workspaceId,
                    namespace: input.namespace,
                    existingNamespace: existingNs,
                    label: concept.label,
                }, 'Namespace violation: cannot mutate attractor owned by another app')
                return { ok: false, error: `Cannot mutate "${concept.label}" — owned by namespace "${existingNs}"` }
            }
        }
    }

    // Snapshot existing IDs so we can identify newly created attractors after mutation.
    const idsBefore = new Set(record.attractors.map(a => a.id))

    const result = mutate(record, input)

    // Tag newly created attractors with the calling app's namespace.
    // Pre-existing attractors (refined or untouched) keep their current namespace.
    for (const attractor of record.attractors) {
        if (!idsBefore.has(attractor.id)) {
            attractor.namespace = input.namespace
        }
    }

    await saveGoldenRecord(workspaceId, record)

    logger.info({
        workspaceId,
        namespace: input.namespace,
        created: result.attractorsCreated,
        refined: result.attractorsRefined,
    }, 'Namespaced SCL mutation applied')

    return { ok: true }
}

// ── Cross-App Event Handler ──────────────────────────────────────────────────

/**
 * Handle a CrossAppEvent by expanding the Golden Record at the
 * specified stimulus and resolution level.
 *
 * Returns the expansion result for the requesting app.
 */
export async function handleCrossAppEvent(
    workspaceId: string,
    event: CrossAppEvent,
): Promise<ExpansionResult | null> {
    if (!(await isSclEnabled(workspaceId))) return null

    const record = await loadGoldenRecord(workspaceId)
    if (!record || record.attractors.length === 0) return null

    const result = expand(record, {
        stimulus: event.stimulus,
        level: event.resolution,
        contextBudget: event.resolution === 'L0' ? 50 : 2000,
        priority: 'relevance',
    })

    logger.info({
        workspaceId,
        sourceApp: event.sourceApp,
        eventType: event.eventType,
        resolution: event.resolution,
        nodesExpanded: result.attractorsExpanded,
    }, 'CrossAppEvent expansion served')

    return result
}
