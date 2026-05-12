import { describe, it, expect } from 'vitest'
import { compileBehavior } from './compiler.js'
import type { ResolvedRule } from './types.js'

describe('Behavior Compiler', () => {
    it('returns empty string when no rules provided', () => {
        expect(compileBehavior([])).toBe('')
    })

    it('compiles safety_constraint correctly', () => {
        const rules: ResolvedRule[] = [
            {
                key: 'safe.1',
                label: 'No Destructive Actions',
                description: 'Do not delete user data.',
                type: 'safety_constraint',
                value: { type: 'boolean', value: true },
                locked: true,
                effectiveSource: 'platform',
                ruleId: '1',
                overriddenBy: null,
            },
            {
                key: 'safe.2',
                label: 'Inactive Constraint',
                description: 'This is disabled.',
                type: 'safety_constraint',
                value: { type: 'boolean', value: false },
                locked: true,
                effectiveSource: 'platform',
                ruleId: '2',
                overriddenBy: null,
            }
        ]

        const compiled = compileBehavior(rules)
        expect(compiled).toContain('## Safety Constraints (non-negotiable)')
        expect(compiled).toContain('- **No Destructive Actions**: Do not delete user data.')
        expect(compiled).not.toContain('Inactive Constraint')
    })

    it('compiles communication_style correctly', () => {
        const rules: ResolvedRule[] = [
            {
                key: 'comm.1',
                label: 'Tone',
                description: 'Agent tone',
                type: 'communication_style',
                value: { type: 'string', value: 'Formal and concise' },
                locked: false,
                effectiveSource: 'workspace',
                ruleId: '1',
                overriddenBy: null,
            }
        ]
        const compiled = compileBehavior(rules)
        expect(compiled).toContain('## Communication Style')
        expect(compiled).toContain('- **Tone**: Formal and concise')
    })

    it('compiles domain_knowledge correctly', () => {
        const rules: ResolvedRule[] = [
            {
                key: 'domain.1',
                label: 'Project Guidelines',
                description: 'Docs',
                type: 'domain_knowledge',
                value: { type: 'text_block', value: 'Always use tabs.' },
                locked: false,
                effectiveSource: 'project',
                ruleId: '1',
                overriddenBy: null,
            }
        ]
        const compiled = compileBehavior(rules)
        expect(compiled).toContain('## Domain Knowledge')
        expect(compiled).toContain('### Project Guidelines')
        expect(compiled).toContain('Always use tabs.')
    })

    it('orders sections correctly', () => {
        const rules: ResolvedRule[] = [
            {
                key: 'dk',
                label: 'DK',
                description: '',
                type: 'domain_knowledge',
                value: { type: 'string', value: 'info' },
                locked: false,
                effectiveSource: 'workspace',
                ruleId: '1',
                overriddenBy: null,
            },
            {
                key: 'sc',
                label: 'SC',
                description: 'sc desc',
                type: 'safety_constraint',
                value: { type: 'boolean', value: true },
                locked: true,
                effectiveSource: 'platform',
                ruleId: '2',
                overriddenBy: null,
            },
            {
                key: 'pt',
                label: 'PT',
                description: '',
                type: 'persona_trait',
                value: { type: 'string', value: 'Friendly' },
                locked: false,
                effectiveSource: 'workspace',
                ruleId: '3',
                overriddenBy: null,
            }
        ]

        const compiled = compileBehavior(rules)
        const ptIndex = compiled.indexOf('## Persona')
        const scIndex = compiled.indexOf('## Safety Constraints')
        const dkIndex = compiled.indexOf('## Domain Knowledge')

        expect(ptIndex).toBeLessThan(scIndex)
        expect(scIndex).toBeLessThan(dkIndex)
    })
})
