import { syncModelKnowledge } from '@plexo/agent/providers/knowledge'
import { runSelfImprovementCycle } from '@plexo/agent/memory/self-improvement'
import { db, sql } from '@plexo/db'
import { logger } from './logger.js'
import { loadWorkspaceAISettings } from './agent-loop.js'

/**
 * Executes background cron jobs.
 * This can be run via an external scheduler (e.g. GitHub Actions, Render cron)
 * or imported and executed periodically by the API server.
 */
export async function runCronJobs() {
    logger.info('Starting cron jobs...')
    try {
        await syncModelKnowledge()
        logger.info('Cron jobs completed successfully.')
    } catch (err) {
        logger.error({ err }, 'Cron jobs failed.')
    }
}

/**
 * Memory consolidation — runs the self-improvement cycle for all workspaces.
 * Called automatically every N hours (see scheduleMemoryConsolidation below)
 * and visible as a cron job in the UI per workspace.
 */
export async function runMemoryConsolidation(): Promise<void> {
    logger.info('Memory consolidation: starting')

    let workspaceIds: string[] = []
    try {
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 50
        `)
        workspaceIds = rows.map((r) => r.id)
    } catch (err) {
        logger.error({ err }, 'Memory consolidation: failed to list workspaces')
        return
    }

    for (const workspaceId of workspaceIds) {
        try {
            const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
            const result = await runSelfImprovementCycle({ workspaceId, aiSettings: aiSettings ?? undefined })
            logger.info({ workspaceId, count: result.proposals }, 'Memory consolidation: cycle complete')
        } catch (err) {
            logger.warn({ err, workspaceId }, 'Memory consolidation: workspace cycle failed (non-fatal)')
        }
    }

    logger.info('Memory consolidation: all workspaces processed')
}

/**
 * In-process scheduler.
 * Runs memory consolidation every 6 hours.
 * Runs model knowledge sync every 24 hours.
 * Both are seeded with an initial delay so they don't block startup.
 */
export function scheduleMemoryConsolidation(): void {
    const SIX_HOURS = 6 * 60 * 60 * 1000

    // First run: 5 minutes after startup (so DB/Redis are warmed)
    setTimeout(() => {
        void runMemoryConsolidation()
        // Then repeat every 6 hours
        setInterval(() => { void runMemoryConsolidation() }, SIX_HOURS)
    }, 5 * 60 * 1000)
}

// If run directly:
if (import.meta.url === `file://${process.argv[1]}`) {
    runCronJobs().catch(console.error).then(() => process.exit(0))
}
