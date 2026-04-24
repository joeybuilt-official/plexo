// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * ModelAttributeBadges — Phase 2a foundation component.
 *
 * Single source of truth for rendering a model's capability flags,
 * strength tags, latency class, and cost class. Phase 2b's chain editor
 * + 506-model catalog browser drop directly on top of this; Phase 1's
 * embedding cards can adopt it later.
 *
 * Pure presentational — takes a `ModelAttributes` shape (the same one
 * `apps/api/src/lib/model-attributes.ts` returns from
 * `models_knowledge` rows) and renders pill rows with the project's
 * style tokens (text-text-primary / text-text-muted / bg-surface-1 / border-border).
 */

import { Brain, Eye, Braces, FileText, Zap, DollarSign, Code2, Globe, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface ModelAttributesView {
    provider: string
    modelId: string
    capabilities: Array<'tools' | 'vision' | 'json_mode' | 'long_context'>
    strengths: Array<'reasoning' | 'speed' | 'cheap' | 'code' | 'multilingual' | 'open_source' | 'creative'>
    latencyClass: 'fast' | 'medium' | 'slow'
    costClass: 'free' | 'cheap' | 'standard' | 'premium'
    contextWindow: number
    blendedCostPerM: number
    bestForHint: string
}

interface BadgeProps {
    icon: LucideIcon
    label: string
    tone?: 'default' | 'cheap' | 'premium' | 'fast' | 'slow'
}

function Badge({ icon: Icon, label, tone = 'default' }: BadgeProps) {
    const toneClass =
        tone === 'cheap' ? 'border-emerald-700/40 text-emerald-300'
        : tone === 'premium' ? 'border-amber-700/40 text-amber-300'
        : tone === 'fast' ? 'border-sky-700/40 text-sky-300'
        : tone === 'slow' ? 'border-rose-700/40 text-rose-300'
        : 'border-border text-text-muted'
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border bg-surface-1 px-2 py-0.5 text-[11px] ${toneClass}`}>
            <Icon className="h-3 w-3" aria-hidden />
            {label}
        </span>
    )
}

const CAPABILITY_LABEL: Record<ModelAttributesView['capabilities'][number], { icon: LucideIcon; label: string }> = {
    tools: { icon: Wrench, label: 'tools' },
    vision: { icon: Eye, label: 'vision' },
    json_mode: { icon: Braces, label: 'json' },
    long_context: { icon: FileText, label: 'long ctx' },
}

const STRENGTH_LABEL: Record<ModelAttributesView['strengths'][number], { icon: LucideIcon; label: string }> = {
    reasoning: { icon: Brain, label: 'reasoning' },
    speed: { icon: Zap, label: 'speed' },
    cheap: { icon: DollarSign, label: 'cheap' },
    code: { icon: Code2, label: 'code' },
    multilingual: { icon: Globe, label: 'multilingual' },
    open_source: { icon: Sparkles, label: 'open' },
    creative: { icon: Sparkles, label: 'creative' },
}

function formatCtx(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
}

function formatCost(blended: number): string {
    if (blended <= 0.001) return 'free'
    if (blended < 1) return `$${blended.toFixed(2)}/M`
    return `$${blended.toFixed(1)}/M`
}

export function ModelAttributeBadges({ attributes, compact }: { attributes: ModelAttributesView; compact?: boolean }) {
    const costTone = attributes.costClass === 'free' || attributes.costClass === 'cheap' ? 'cheap'
        : attributes.costClass === 'premium' ? 'premium' : 'default'
    const latencyTone = attributes.latencyClass === 'fast' ? 'fast'
        : attributes.latencyClass === 'slow' ? 'slow' : 'default'

    return (
        <div className="flex flex-wrap items-center gap-1">
            <Badge icon={DollarSign} label={formatCost(attributes.blendedCostPerM)} tone={costTone} />
            <Badge icon={Zap} label={attributes.latencyClass} tone={latencyTone} />
            <Badge icon={FileText} label={`${formatCtx(attributes.contextWindow)} ctx`} />
            {attributes.capabilities.map(c => {
                const meta = CAPABILITY_LABEL[c]
                return <Badge key={`cap-${c}`} icon={meta.icon} label={meta.label} />
            })}
            {!compact && attributes.strengths.map(s => {
                const meta = STRENGTH_LABEL[s]
                return <Badge key={`str-${s}`} icon={meta.icon} label={meta.label} />
            })}
        </div>
    )
}
