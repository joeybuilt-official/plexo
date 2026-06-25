import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveBehavior } from './resolver.js'
import type { BehaviorRule } from './types.js'

const { wsParams, projParams } = vi.hoisted(() => ({
    wsParams: { current: [] as BehaviorRule[] },
    projParams: { current: [] as BehaviorRule[] }
}))

vi.mock('@plexo/db', () => ({
    db: {
        select: vi.fn(() => ({
            from: () => ({
                where: (cond: string) => {
                    let result: BehaviorRule[]
                    if (cond && typeof cond === 'string') {
                        if (cond.includes('proj')) {
                            result = projParams.current
                        } else if (cond.includes('ws')) {
                            result = wsParams.current
                        } else {
                            result = []
                        }
                    } else {
                        result = []
                    }
                    const chainable = { limit: () => Promise.resolve(result), then: undefined as any }
                    // Make it thenable so `await` without .limit() also works
                    chainable.then = (resolve: (v: BehaviorRule[]) => unknown) => Promise.resolve(result).then(resolve)
                    return chainable
                }
            })
        })),
        insert: vi.fn(() => ({
            values: vi.fn().mockResolvedValue(true)
        }))
    },
    eq: vi.fn((col, val) => `eq:${String(col)}:${val}`),
    and: vi.fn((...args) => `and:${args.join('|')}`),
    isNull: vi.fn((col) => `isNull:${String(col)}`),
    behaviorRules: {},
    behaviorSnapshots: {}
}))

// ADR-0045 Phase 2: source imports drizzle operators from 'drizzle-orm' now.
// Mirror whatever operator stubs the @plexo/db mock defines so the fake db
// still sees the same recognizable shapes (fall back to real drizzle otherwise).
vi.mock('drizzle-orm', async (importOriginal) => {
    const real = await importOriginal<Record<string, unknown>>()
    const m = (await import('@plexo/db')) as Record<string, unknown>
    const pick = (k: string): unknown => (k in m ? m[k] : real[k])
    return {
        ...real,
        eq: pick('eq'), and: pick('and'), or: pick('or'), ne: pick('ne'),
        desc: pick('desc'), asc: pick('asc'), inArray: pick('inArray'),
        isNull: pick('isNull'), isNotNull: pick('isNotNull'), ilike: pick('ilike'),
        lt: pick('lt'), lte: pick('lte'), gte: pick('gte'), count: pick('count'),
        sql: pick('sql'),
    }
})


vi.mock('./compiler.js', () => ({
    compileBehavior: vi.fn((rules) => rules.map((r: any) => r.key).join(','))
}))

const baseWsDate = new Date()
const baseProjDate = new Date()

describe('Behavior Resolver', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        wsParams.current = []
        projParams.current = []
    })

    it('merges layers correctly (platform <- workspace <- project <- task)', async () => {
        wsParams.current = [{
            id: 'ws-1',
            workspaceId: 'ws',
            projectId: null,
            type: 'communication_style',
            key: 'response_verbosity',
            label: 'Verbosity',
            description: '',
            value: { type: 'enum', value: 'concise', options: [] },
            locked: false,
            source: 'workspace',
            overridesRuleId: null,
            tags: [],
            createdAt: baseWsDate,
            updatedAt: baseWsDate,
            deletedAt: null
        }]

        projParams.current = [{
            id: 'proj-1',
            workspaceId: 'ws',
            projectId: 'proj',
            type: 'domain_knowledge',
            key: 'domain.stack',
            label: 'Stack',
            description: '',
            value: { type: 'string', value: 'TypeScript' },
            locked: false,
            source: 'project',
            overridesRuleId: null,
            tags: [],
            createdAt: baseProjDate,
            updatedAt: baseProjDate,
            deletedAt: null
        }]

        const mockTaskRule: BehaviorRule = {
            id: 'task-1',
            workspaceId: 'ws',
            projectId: 'proj',
            type: 'operational_rule',
            key: 'agent.mode',
            label: 'Mode',
            description: '',
            value: { type: 'string', value: 'fast' },
            locked: false,
            source: 'task',
            overridesRuleId: null,
            tags: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
        }
        
        const resolved = await resolveBehavior('ws', 'proj', [mockTaskRule], { snapshot: false })
        
        expect(resolved.workspaceId).toBe('ws')
        expect(resolved.projectId).toBe('proj')
        
        const verbosity = resolved.rules.find(r => r.key === 'response_verbosity')
        expect(verbosity?.effectiveSource).toBe('workspace')
        expect(verbosity?.value.value).toBe('concise')
        
        const stack = resolved.rules.find(r => r.key === 'domain.stack')
        expect(stack?.effectiveSource).toBe('project')
        
        const taskMode = resolved.rules.find(r => r.key === 'agent.mode')
        expect(taskMode?.effectiveSource).toBe('task')
        
        const pb = resolved.rules.find(r => r.key === 'never_output_secrets')
        expect(pb?.effectiveSource).toBe('platform')
    })
    
    it('overrides rules exactly when keys match', async () => {
        wsParams.current = [{
            id: 'ws-1',
            workspaceId: 'ws',
            projectId: null,
            type: 'communication_style',
            key: 'response_verbosity',
            label: 'Verbosity WS',
            description: '',
            value: { type: 'enum', value: 'verbose', options: [] },
            locked: false,
            source: 'workspace',
            overridesRuleId: null,
            tags: [],
            createdAt: baseWsDate,
            updatedAt: baseWsDate,
            deletedAt: null
        }]

        projParams.current = [{
            id: 'proj-1',
            workspaceId: 'ws',
            projectId: 'proj',
            type: 'communication_style',
            key: 'response_verbosity',
            label: 'Verbosity Proj',
            description: '',
            value: { type: 'enum', value: 'minimal', options: [] },
            locked: false,
            source: 'project',
            overridesRuleId: null,
            tags: [],
            createdAt: baseProjDate,
            updatedAt: baseProjDate,
            deletedAt: null
        }]

        const resolved = await resolveBehavior('ws', 'proj', [], { snapshot: false })
        const verbosity = resolved.rules.find(r => r.key === 'response_verbosity')
        expect(verbosity?.effectiveSource).toBe('project')
        expect(verbosity?.value.value).toBe('minimal')
        expect(verbosity?.overriddenBy?.source).toBe('workspace')
    })
})
