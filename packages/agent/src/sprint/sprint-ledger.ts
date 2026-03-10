// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, sql } from '@plexo/db'
import { sprintHandoffs, sprintFileEvents, sprintPatterns, sprints, sprintTasks } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'sprint-ledger' })

export async function logSprintHandoff(params: {
    sprintId: string
    taskId?: string
    summary: string
    filesChanged: string[]
    concerns: string[]
    suggestions: string[]
    tokensUsed: number
    toolCalls: number
    durationMs: number
}) {
    await db.insert(sprintHandoffs).values({
        id: crypto.randomUUID(),
        sprintId: params.sprintId,
        taskId: params.taskId,
        summary: params.summary,
        filesChanged: params.filesChanged,
        concerns: params.concerns,
        suggestions: params.suggestions,
        tokensUsed: params.tokensUsed,
        toolCalls: params.toolCalls,
        durationMs: params.durationMs,
        suspicious: params.filesChanged.length === 0,
    })
}

export async function logSprintFileEvent(params: {
    sprintId: string
    repo: string
    eventType: 'lock' | 'conflict' | 'change' | 'build_error' | 'ts_error'
    filePath: string
    message?: string
}) {
    await db.insert(sprintFileEvents).values({
        id: crypto.randomUUID(),
        sprintId: params.sprintId,
        repo: params.repo,
        eventType: params.eventType,
        filePath: params.filePath,
        message: params.message,
    })
}

export async function refreshSprintPatterns(repo: string, sprintId: string) {
    try {
        // Find hotspots based on file events
        const hotSpots = await db.execute(sql`
            SELECT file_path as "filePath", COUNT(*) as c
            FROM sprint_file_events
            WHERE repo = ${repo} AND event_type IN ('conflict', 'lock', 'build_error')
            GROUP BY file_path
            HAVING COUNT(*) > 2
        `) as Record<string, unknown>[]

        for (const row of hotSpots) {
            await db.insert(sprintPatterns).values({
                id: crypto.randomUUID(),
                repo,
                patternType: 'conflict_hotspot',
                subject: String(row.filePath),
                occurrences: Number(row.c),
            }).onConflictDoUpdate({
                target: [sprintPatterns.repo, sprintPatterns.patternType, sprintPatterns.subject],
                set: {
                    occurrences: sql`sprint_patterns.occurrences + 1`,
                    lastSeenAt: new Date(),
                }
            })
        }

        logger.info({ repo, sprintId }, 'Sprint patterns refreshed')
    } catch (err) {
        logger.error({ err, repo, sprintId }, 'Failed to refresh sprint patterns')
    }
}
