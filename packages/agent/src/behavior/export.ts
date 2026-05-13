// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { BehaviorRule } from './types.js'

export function generateAgentsMd(rules: BehaviorRule[]): string {
    let md = '# AGENTS.md (Auto-generated)\n\n'
    md += '> This file is auto-generated from Plexo Agent Behavior settings. Do not edit directly.\n\n'
    
    // Group by rule type
    const byType = rules.reduce((acc, rule) => {
        if (!acc[rule.type]) acc[rule.type] = []
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        acc[rule.type]!.push(rule)
        return acc
    }, {} as Record<string, BehaviorRule[]>)

    for (const [type, typeRules] of Object.entries(byType)) {
        md += `## ${type.toUpperCase().replace(/_/g, ' ')}\n\n`
        for (const rule of typeRules) {
            md += `### ${rule.label}\n`
            if (rule.description) md += `*${rule.description}*\n\n`
            
            if (rule.value.type === 'boolean') {
                md += `**Enabled:** ${rule.value.value ? 'Yes' : 'No'}\n\n`
            } else if (rule.value.type === 'string' || rule.value.type === 'number' || rule.value.type === 'enum') {
                md += `**Value:** ${rule.value.value}\n\n`
            } else if (rule.value.type === 'text_block') {
                md += `${rule.value.value as string}\n\n`
            } else {
                md += '```json\n' + JSON.stringify(rule.value.value, null, 2) + '\n```\n\n'
            }
        }
    }

    return md
}
