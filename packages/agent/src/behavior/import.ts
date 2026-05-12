// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { BehaviorRule, RuleType } from './types.js'

export function parseAgentsMd(content: string): Partial<BehaviorRule>[] {
    const rules: Partial<BehaviorRule>[] = []
    
    const regex = /^(#+)\s+(.*)$/gm
    let match
    let lastIndex = 0
    let lastHeader = 'General Context'
    const segments: { header: string, content: string }[] = []

    while ((match = regex.exec(content)) !== null) {
        if (lastIndex < match.index) {
            const segContent = content.slice(lastIndex, match.index).trim()
            if (segContent) {
                segments.push({ header: lastHeader, content: segContent })
            }
        }
        lastHeader = match[2]!
        lastIndex = regex.lastIndex
    }
    
    if (lastIndex < content.length) {
        const segContent = content.slice(lastIndex).trim()
        if (segContent) {
            segments.push({ header: lastHeader, content: segContent })
        }
    }

    if (segments.length === 0 && content.trim()) {
        segments.push({ header: 'Imported', content: content.trim() })
    }

    for (const seg of segments) {
        if (!seg.content) continue
        
        let type: RuleType = 'domain_knowledge'
        const lower = seg.header.toLowerCase()
        if (lower.includes('safe') || lower.includes('security') || lower.includes('gate')) type = 'safety_constraint'
        else if (lower.includes('communicat') || lower.includes('tone') || lower.includes('style')) type = 'communication_style'
        else if (lower.includes('operat') || lower.includes('process') || lower.includes('deploy') || lower.includes('conventions')) type = 'operational_rule'
        else if (lower.includes('tool') || lower.includes('command') || lower.includes('stack')) type = 'tool_preference'
        else if (lower.includes('quality') || lower.includes('test')) type = 'quality_gate'
        else if (lower.includes('persona') || lower.includes('identity')) type = 'persona_trait'

        const randomHex = Math.random().toString(16).slice(2, 8)
        const keyBase = seg.header.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40)

        rules.push({
            type,
            key: `import_${keyBase || 'block'}_${randomHex}`,
            label: `Imported: ${seg.header}`,
            description: `Imported from AGENTS.md`,
            value: { type: 'text_block', value: seg.content },
        })
    }

    return rules
}
