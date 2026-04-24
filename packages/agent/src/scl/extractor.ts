// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL-S Structural Extraction
 *
 * Extracts a structural skeleton from completed task metadata.
 * NO user content, NO prompt text, NO completion text — only structural signals.
 */

import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { DomainRegion } from './classifier.js'

const logger = pino({ name: 'scl:extractor' })

export interface SclSGraph {
    id: string
    domainRegion: DomainRegion | string
    taskType: string
    toolsUsed: string[]
    skillsActivated: string[]
    agentCount: number
    stepCount: number
    quality: number | null
    timestamp: string
}

export interface CompletedTaskMeta {
    taskId: string
    workspaceId: string
    type: string
    domainRegion: string
    toolsUsed?: string[]
    skillsActivated?: string[]
    childTaskCount?: number
    stepCount: number
    qualityScore: number | null
    completedAt: Date
    inferenceLogId?: string
}

/**
 * Extract SCL-S structural graph from task completion metadata.
 */
export function extractSclS(task: CompletedTaskMeta): SclSGraph {
    return {
        id: randomUUID(),
        domainRegion: task.domainRegion,
        taskType: task.type,
        toolsUsed: task.toolsUsed ?? [],
        skillsActivated: task.skillsActivated ?? [],
        agentCount: (task.childTaskCount ?? 0) + 1,
        stepCount: task.stepCount,
        quality: task.qualityScore,
        timestamp: task.completedAt.toISOString(),
    }
}

/**
 * Extract and persist SCL-S graph after task completion.
 */
export async function extractAndStoreSclS(task: CompletedTaskMeta): Promise<string | null> {
    try {
        const graph = extractSclS(task)
        const { db, sql } = await import('@plexo/db')

        await db.execute(sql`
            INSERT INTO scl_concept_graphs (id, source_log_id, workspace_id, domain_region, graph_json)
            VALUES (
                ${graph.id}::uuid,
                ${task.inferenceLogId ?? null}${task.inferenceLogId ? sql`::uuid` : sql``},
                ${task.workspaceId}::uuid,
                ${graph.domainRegion},
                ${JSON.stringify(graph)}::jsonb
            )
        `)

        logger.info({ graphId: graph.id, workspaceId: task.workspaceId, region: graph.domainRegion, taskType: graph.taskType, toolCount: graph.toolsUsed.length }, 'extractAndStoreSclS: graph stored')
        return graph.id
    } catch (err) {
        logger.warn({ err, taskId: task.taskId }, 'Failed to store SCL-S graph — non-fatal')
        return null
    }
}
