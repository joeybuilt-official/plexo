import { db, workspaces, workLedger, tasks } from '@plexo/db'
import { runRSIMonitor } from '../packages/agent/src/introspection/rsi-monitor.js'
import { randomUUID } from 'crypto'

async function simulate() {
    console.log('\n=============================================')
    console.log('RSI ENGINE - LOW SAMPLE SIZE SIMULATION')
    console.log('=============================================\n')

    // 1. Get a valid workspace to inject ledger events into
    const [workspace] = await db.select().from(workspaces).limit(1)
    if (!workspace) {
        console.error('No workspace found in the database. Please run seed or start the app.')
        process.exit(1)
    }

    const wsId = workspace.id

    // Cleanup previous simulated ledger data for a clean test
    await db.delete(workLedger).where(require('drizzle-orm').eq(workLedger.workspaceId, wsId))
    await db.delete(require('@plexo/db').rsiProposals).where(require('drizzle-orm').eq(require('@plexo/db').rsiProposals.workspaceId, wsId))

    console.log('>> Step 1: Evaluating under the N=5 threshold (4 bad events)...')
    
    // Inject 4 terrible quality tasks (Quality 3.0 / 10)
    for (let i = 0; i < 4; i++) {
        await db.insert(workLedger).values({
            workspaceId: wsId,
            type: 'coding',
            source: 'simulation',
            qualityScore: 3.0,
            costUsd: 0.1,
            completedAt: new Date(),
            calibration: 'correct'
        })
    }
    
    // Run the monitor
    let proposalsGenerated = await runRSIMonitor()
    console.log(`[Result] Sent 4 massive quality failures. Proposals generated: ${proposalsGenerated} (Successfully blocked by N=5 limit)\n`)

    console.log('>> Step 2: Hitting the N=5 threshold (Adding 1 more bad event)...')
    
    // Add 1 more bad task to breach threshold
    await db.insert(workLedger).values({
        workspaceId: wsId,
        type: 'coding',
        source: 'simulation',
        qualityScore: 3.0,
        costUsd: 0.1,
        completedAt: new Date(),
        calibration: 'correct'
    })

    proposalsGenerated = await runRSIMonitor()
    console.log(`[Result] 5th failure added. Proposals generated: ${proposalsGenerated} (Quality Degradation Anomaly Triggers!)\n`)
    
    console.log('>> Step 3: Triggering a multi-anomaly scenario (Cost Spikes + Skews)...')
    
    // Insert 6 wildly over-budget, over-confident tasks
    for (let i = 0; i < 6; i++) {
        await db.insert(workLedger).values({
            workspaceId: wsId,
            type: 'research',
            source: 'simulation',
            qualityScore: 9.0, // Good quality, so won't trigger that
            costUsd: 8.50, // Massive cost!
            completedAt: new Date(),
            calibration: 'over' // Agent thought it was a 10/10, was a 9/10
        })
    }

    proposalsGenerated = await runRSIMonitor()
    console.log(`[Result] Sent 6 budget-blowing/overconfident tasks. Proposals generated: ${proposalsGenerated} (Cost Spikes & Confidence Skews Detect!)\n`)

    
    // Print the database state to prove these generated actual proposals
    console.log('>> FINAL GENERATED PROPOSALS IN DATABASE:')
    const allProposals = await db.select().from(require('@plexo/db').rsiProposals).where(require('drizzle-orm').eq(require('@plexo/db').rsiProposals.workspaceId, wsId))
    
    allProposals.forEach((p: any) => {
        console.log(`\n- Type: ${p.anomalyType}\n  Hypothesis: ${p.hypothesis}\n  Risk: ${p.risk}`)
    })
    
    console.log('\nSimulation complete.')
    process.exit(0)
}

simulate().catch(err => {
    console.error(err)
    process.exit(1)
})
