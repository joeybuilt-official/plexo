// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, eq, sql } from '@plexo/db'
import { sprintPatterns, sprints } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'sprint-intelligence' })

export class SprintIntelligence {
    repo: string

    constructor(repo: string) {
        this.repo = repo
    }

    async getPriorIntelligence(): Promise<string> {
        try {
            const patterns = await db.select().from(sprintPatterns).where(eq(sprintPatterns.repo, this.repo))
            
            if (patterns.length === 0) return ''

            const hotspots = patterns.filter(p => p.patternType === 'conflict_hotspot')
            const recurringErrors = patterns.filter(p => p.patternType === 'recurring_error')

            let content = '--- PRIOR SPRINT INTELLIGENCE ---\n'
            
            if (hotspots.length > 0) {
                content += '\n[Known Conflict Hotspots]\n'
                content += 'Please isolate work carefully on these files to decrease merge conflict chance:\n'
                for (const h of hotspots) {
                    content += `- ${h.subject} (${h.occurrences} past conflicts)\n`
                }
            }

            if (recurringErrors.length > 0) {
                content += '\n[Recurring Acceptance/Build Errors]\n'
                for (const r of recurringErrors) {
                    content += `- ${r.subject} (occurred ${r.occurrences} times recently)\n`
                }
            }

            return content
        } catch (err) {
            logger.error({ err }, 'Failed to fetch sprint intelligence')
            return ''
        }
    }

    async forecastQuality(sprintId: string, goal: string, scopeFiles: string[]): Promise<number> {
        try {
            // 1. Base Rate
            const allSprints = await db.select().from(sprints).where(eq(sprints.repo, this.repo))
            const completed = allSprints.filter(s => s.status === 'complete').length
            const baseRate = allSprints.length > 0 ? (completed / allSprints.length) : 0.5

            // 2. Complexity
            const words = goal.split(/\s+/).length
            const complexityPenalty = (scopeFiles.length * 0.1) + (words / 300)

            // 3. Hotspot Density
            const hotspots = await db.select().from(sprintPatterns).where(eq(sprintPatterns.patternType, 'conflict_hotspot'))
            const hotspotSubjects = new Set(hotspots.map(h => h.subject))
            const involvedHotspots = scopeFiles.filter(f => hotspotSubjects.has(f)).length
            const hotspotPenalty = involvedHotspots * 0.2

            // 4. Recency Penalty
            let recencyPenalty = 0
            const lastSprint = allSprints.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
            if (lastSprint && lastSprint.status === 'failed') {
                recencyPenalty = 0.1
            }

            let forecast = baseRate - complexityPenalty - hotspotPenalty - recencyPenalty
            
            // Constrain
            forecast = Math.max(0.1, Math.min(forecast, 0.95))

            // Update forecast on sprint
            await db.update(sprints)
                .set({ metadata: sql`${sprints.metadata} || ${JSON.stringify({ forecastScore: forecast })}::jsonb` })
                .where(eq(sprints.id, sprintId))

            return forecast
        } catch (err) {
            logger.error({ err }, 'Failed to forecast sprint quality')
            return 0.5
        }
    }
}
