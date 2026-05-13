import { describe, it, expect, vi } from 'vitest'

// Mock DB and event-bus so module loads in the package-local Vitest runner
// (root vitest.config.ts aliases only apply when running from workspace root)
vi.mock('@plexo/db', () => ({
    db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })) },
    workLedger: {}, rsiProposals: {}, workspaces: {},
    eq: vi.fn(), gte: vi.fn(), and: vi.fn(), desc: vi.fn(),
}))

vi.mock('../plugins/event-bus.js', () => ({
    eventBus: { emit: vi.fn() },
    TOPICS: { RSI_PROPOSAL_CREATED: 'rsi.proposal.created' },
}))

import { detectAnomalies } from './rsi-monitor.js'

describe('RSI Monitor Anomaly Detection', () => {

    it('should ignore data when sample size is insufficient (< 5 per constraint)', () => {
        const tasks = [
            { qualityScore: 2.0 },
            { qualityScore: 2.0 },
            { qualityScore: 2.0 }
        ]
        const proposals = detectAnomalies(tasks)
        expect(proposals).toHaveLength(0)
    })

    it('should detect quality_degradation when average quality is below 6.0', () => {
        const tasks = [
            { qualityScore: 5.0 },
            { qualityScore: 4.0 },
            { qualityScore: 3.0 },
            { qualityScore: 2.0 },
            { qualityScore: 5.0 }
        ]
        const proposals = detectAnomalies(tasks)
        const degradation = proposals.find(p => p.type === 'quality_degradation')
        
        expect(degradation).toBeDefined()
        expect(degradation?.risk).toBe('medium')
        expect(degradation?.hypothesis).toMatch(/Average quality dropped to/)
    })

    it('should detect confidence_skew when >40% of tasks are overconfident', () => {
        const tasks = [
            { calibration: 'over' },
            { calibration: 'over' },
            { calibration: 'over' },
            { calibration: 'under' },
            { calibration: 'aligned' }
        ]
        const proposals = detectAnomalies(tasks)
        const skew = proposals.find(p => p.type === 'confidence_skew')

        expect(skew).toBeDefined()
        expect(skew?.risk).toBe('low')
        expect(skew?.hypothesis).toMatch(/failed to meet initial confidence/)
    })

    it('should detect cost_spikes when recent half is >2x the prior half avg', () => {
        // Sort is by completedAt; explicit timestamps make the split deterministic
        const now = Date.now()
        const tasks = [
            // Prior half (older) — low cost ~0.11 avg
            { costUsd: 0.10, completedAt: new Date(now - 5000) },
            { costUsd: 0.12, completedAt: new Date(now - 4000) },
            // Recent half — >2x prior: ~1.77 avg
            { costUsd: 1.50, completedAt: new Date(now - 3000) },
            { costUsd: 1.80, completedAt: new Date(now - 2000) },
            { costUsd: 2.00, completedAt: new Date(now - 1000) },
        ]
        const proposals = detectAnomalies(tasks)
        const spike = proposals.find(p => p.type === 'cost_spikes')

        expect(spike).toBeDefined()
        expect(spike?.risk).toBe('high')
        expect(spike?.hypothesis).toMatch(/Average task cost spiked to/)
    })

    it('should not throw false positives on healthy work ledgers', () => {
        const tasks = [
            { qualityScore: 9.0, calibration: 'aligned', costUsd: 0.10 },
            { qualityScore: 9.5, calibration: 'aligned', costUsd: 0.20 },
            { qualityScore: 8.5, calibration: 'under', costUsd: 0.30 },
            { qualityScore: 10.0, calibration: 'aligned', costUsd: 0.15 },
            { qualityScore: 9.0, calibration: 'aligned', costUsd: 0.25 }
        ]
        const proposals = detectAnomalies(tasks)
        expect(proposals).toHaveLength(0)
    })
})
