import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runRSIMonitor } from '../../../packages/agent/src/introspection/rsi-monitor.js'
import { db, workspaces, workLedger, rsiProposals } from '@plexo/db'

vi.mock('@plexo/db', async () => {
    const defaultMocks = {
        workspaces: { id: 'test-workspace' },
        workLedger: { workspaceId: 'test-workspace' },
        rsiProposals: { id: 'test-proposal', workspaceId: 'test-workspace', anomalyType: 'quality_degradation', status: 'pending' },
        db: {
            select: vi.fn().mockReturnThis(),
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            insert: vi.fn().mockReturnThis(),
            values: vi.fn().mockResolvedValue([]),
        },
        eq: vi.fn(),
        gte: vi.fn(),
        and: vi.fn(),
        sql: vi.fn(),
        desc: vi.fn()
    }
    return defaultMocks
})

describe('RSI Engine - Sample Size Constraints', () => {

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('Scenario 1: Should NOT trigger RSI proposals when low-quality sample size < 5 (N=4)', async () => {
         // Mock workspace retrieval — chain ends at .limit(500)
         // @ts-expect-error Mocking db
         db.limit.mockResolvedValueOnce([{ id: 'ws1' }])

         // Mock returning only 4 very poor executions (Avg Quality = 3.0/10)
         // Even though performance is catastrophic, N=4 should stop the generation to prevent noise
         // chain ends at .limit(1000) — @ts-expect-error Mocking db
         db.limit.mockResolvedValueOnce([
            { id: '1',  type: 'ops', source: 'telegram', qualityScore: 3.0, completedAt: new Date() },
            { id: '2',  type: 'coding', source: 'dashboard', qualityScore: 3.5, completedAt: new Date() },
            { id: '3',  type: 'coding', source: 'telegram', qualityScore: 2.5, completedAt: new Date() },
            { id: '4',  type: 'research', source: 'cron', qualityScore: 3.0, completedAt: new Date() },
         ])

         const insertions = await runRSIMonitor()
         
         // 0 proposals generated because N < 5
         expect(insertions).toBe(0)
    })

    it('Scenario 2: Should trigger RSI proposals when bad sample size crosses boundary >= 5 (N=5)', async () => {
        // Mock workspace retrieval — chain ends at .limit(500)
        // @ts-expect-error
        db.limit.mockResolvedValueOnce([{ id: 'ws1' }])

        // Return 5 very poor executions — chain ends at .limit(1000)
        // @ts-expect-error
        db.limit.mockResolvedValueOnce([
            { id: '1', qualityScore: 3.0, completedAt: new Date() },
            { id: '2', qualityScore: 3.5, completedAt: new Date() },
            { id: '3', qualityScore: 2.5, completedAt: new Date() },
            { id: '4', qualityScore: 3.0, completedAt: new Date() },
            { id: '5', qualityScore: 4.0, completedAt: new Date() } // The 5th task crossing the minimum boundary!
        ])

        // Mock exact existing proposals lookup to show no pending collisions
        // @ts-expect-error
        db.limit.mockResolvedValueOnce([])

        const insertions = await runRSIMonitor()
        
        // Exactly 1 proposal generated ("quality_degradation") because N=5 limit met and threshold (<6.0) breached 
        expect(insertions).toBe(1)
        expect(db.insert).toHaveBeenCalledWith(rsiProposals)
    })
})
