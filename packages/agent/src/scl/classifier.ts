// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Domain region classifier for inference logs.
 *
 * Lightweight keyword-based classification — no LLM or embedding calls.
 * Matches task descriptions and tool usage patterns to domain regions.
 */

import pino from 'pino'

const logger = pino({ name: 'scl:classifier' })

export const DOMAIN_REGIONS = [
    'code',
    'writing',
    'data-analysis',
    'planning',
    'research',
    'qa',
    'conversation',
    'creative',
] as const

export type DomainRegion = typeof DOMAIN_REGIONS[number]

const REGION_KEYWORDS: Record<DomainRegion, string[]> = {
    'code': ['code', 'function', 'bug', 'refactor', 'typescript', 'javascript', 'python', 'api', 'endpoint', 'test', 'build', 'compile', 'deploy', 'git', 'commit', 'pr', 'pull request', 'lint', 'fix'],
    'writing': ['write', 'draft', 'edit', 'blog', 'article', 'copy', 'email', 'document', 'summary', 'report', 'prose', 'content', 'changelog', 'readme'],
    'data-analysis': ['data', 'analyze', 'csv', 'spreadsheet', 'chart', 'graph', 'metrics', 'dashboard', 'sql', 'query', 'aggregate', 'statistics', 'trend'],
    'planning': ['plan', 'roadmap', 'strategy', 'architecture', 'design', 'spec', 'requirements', 'milestone', 'sprint', 'scope', 'estimate', 'breakdown'],
    'research': ['research', 'investigate', 'find', 'search', 'compare', 'evaluate', 'benchmark', 'alternatives', 'options', 'audit', 'review'],
    'qa': ['test', 'qa', 'verify', 'validate', 'check', 'assert', 'regression', 'coverage', 'e2e', 'integration', 'unit test'],
    'conversation': ['chat', 'ask', 'explain', 'help', 'question', 'answer', 'clarify', 'discuss'],
    'creative': ['design', 'creative', 'brainstorm', 'ideate', 'generate', 'imagine', 'concept', 'prototype', 'mockup', 'ui', 'ux'],
}

/**
 * Classify a task description into a domain region.
 * Returns the region with the highest keyword match score.
 */
export function classifyDomainRegion(taskDescription: string, taskType?: string): DomainRegion {
    const text = `${taskDescription} ${taskType ?? ''}`.toLowerCase()

    let bestRegion: DomainRegion = 'conversation'
    let bestScore = 0

    for (const [region, keywords] of Object.entries(REGION_KEYWORDS) as [DomainRegion, string[]][]) {
        let score = 0
        for (const kw of keywords) {
            if (text.includes(kw)) score++
        }
        if (score > bestScore) {
            bestScore = score
            bestRegion = region
        }
    }

    return bestRegion
}

/**
 * Classify an inference log row asynchronously and update the DB.
 */
export async function classifyInferenceLog(
    logId: string,
    taskDescription: string,
    taskType?: string,
): Promise<DomainRegion> {
    const region = classifyDomainRegion(taskDescription, taskType)

    try {
        const { db, sql } = await import('@plexo/db')
        await db.execute(sql`
            UPDATE inference_logs SET domain_region = ${region} WHERE id = ${logId}::uuid
        `)

        // Check bucket threshold
        const rows = await db.execute<{ count: number }>(sql`
            SELECT count(*) as count FROM inference_logs WHERE domain_region = ${region}
        `)
        const count = Number(rows[0]?.count ?? 0)
        if (count >= 2000) {
            logger.info({ region, count }, 'SCL bucket ready — awaiting P6 runtime')
        }
    } catch (err) {
        logger.warn({ err, logId }, 'Failed to classify inference log — non-fatal')
    }

    return region
}
