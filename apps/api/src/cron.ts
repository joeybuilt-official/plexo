import { syncModelKnowledge } from '@plexo/agent/providers/knowledge'
import { logger } from './logger.js'

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

// If run directly:
if (import.meta.url === `file://${process.argv[1]}`) {
    runCronJobs().catch(console.error).then(() => process.exit(0))
}
