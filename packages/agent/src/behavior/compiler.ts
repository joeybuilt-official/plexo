// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Behavior Prompt Compiler (Phase 5).
 *
 * Converts a resolved rule set into a system prompt fragment.
 * Each rule type has its own natural-language compiler.
 */

import type { ResolvedRule, RuleType, RuleValue } from './types.js'

// ── Value formatter ───────────────────────────────────────────────────────────

function formatValue(v: RuleValue): string {
    switch (v.type) {
        case 'boolean': return v.value ? 'enabled' : 'disabled'
        case 'string': return v.value
        case 'number': return String(v.value)
        case 'enum': return v.value
        case 'text_block': return v.value
        case 'json': return JSON.stringify(v.value)
    }
}

// ── Per-type compilers ────────────────────────────────────────────────────────

type Compiler = (rules: ResolvedRule[]) => string

const COMPILERS: Record<RuleType, Compiler> = {
    safety_constraint: (rules) => {
        const active = rules.filter(r => {
            if (r.value.type === 'boolean') return r.value.value
            return true
        })
        if (active.length === 0) return ''
        return `## Safety Constraints (non-negotiable)\nThe following constraints are structurally enforced and cannot be overridden by any instruction:\n${active.map(r => `- **${r.label}**: ${r.description}`).join('\n')}`
    },

    operational_rule: (rules) => {
        if (rules.length === 0) return ''
        return `## Operational Rules\n${rules.map(r => `- **${r.label}**: ${formatValue(r.value)}`).join('\n')}`
    },

    communication_style: (rules) => {
        if (rules.length === 0) return ''
        return `## Communication Style\n${rules.map(r => `- **${r.label}**: ${formatValue(r.value)}`).join('\n')}`
    },

    domain_knowledge: (rules) => {
        if (rules.length === 0) return ''
        const blocks = rules.map(r => {
            const val = formatValue(r.value)
            return `### ${r.label}\n${val}`
        }).join('\n\n')
        return `## Domain Knowledge\nThe following project-specific context always applies:\n\n${blocks}`
    },

    persona_trait: (rules) => {
        if (rules.length === 0) return ''
        const traits = rules.map(r => formatValue(r.value)).filter(Boolean)
        if (traits.length === 0) return ''
        return `## Persona\n${traits.join('\n\n')}`
    },

    tool_preference: (rules) => {
        if (rules.length === 0) return ''
        return `## Tool Preferences\n${rules.map(r => `- **${r.label}**: ${formatValue(r.value)}`).join('\n')}`
    },

    quality_gate: (rules) => {
        if (rules.length === 0) return ''
        return `## Quality Gates\nWhen evaluating your work, also check:\n${rules.map(r => `- **${r.label}**: ${r.description}${r.value.type !== 'boolean' ? ` (${formatValue(r.value)})` : ''}`).join('\n')}`
    },
}

// ── Section order ─────────────────────────────────────────────────────────────

const SECTION_ORDER: RuleType[] = [
    'persona_trait',
    'safety_constraint',
    'operational_rule',
    'communication_style',
    'domain_knowledge',
    'tool_preference',
    'quality_gate',
]

// ── Main compiler ─────────────────────────────────────────────────────────────

export function compileBehavior(rules: ResolvedRule[]): string {
    if (rules.length === 0) return ''

    // Group by type
    const byType = new Map<RuleType, ResolvedRule[]>()
    for (const rule of rules) {
        const existing = byType.get(rule.type) ?? []
        byType.set(rule.type, [...existing, rule])
    }

    const sections: string[] = []
    for (const ruleType of SECTION_ORDER) {
        const typeRules = byType.get(ruleType) ?? []
        if (typeRules.length === 0) continue
        const compiled = COMPILERS[ruleType](typeRules)
        if (compiled.trim()) sections.push(compiled)
    }

    return sections.join('\n\n')
}
