// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'
import {
    Settings2, Save, Check, RefreshCw, AlertCircle, HelpCircle, X,
    Scale, Shield, Zap, Brain, Rocket, FlaskConical,
} from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface SclConfig {
    spiritDriftThreshold: number
    promotionMutationCount: number
    expansionBudgetL0: number
    expansionBudgetL1: number
    expansionBudgetL2: number
    ghostDisplacementThreshold: number
}

interface Bounds {
    min: number
    max: number
}

interface ConfigResponse {
    config: SclConfig
    defaults: SclConfig
    bounds: Record<string, Bounds>
}

const LABELS: Record<keyof SclConfig, { label: string; description: string; step: number }> = {
    spiritDriftThreshold: {
        label: 'Spirit Drift Threshold',
        description: 'Max semantic distance before drift warning on spirit anchors',
        step: 0.01,
    },
    promotionMutationCount: {
        label: 'Promotion Threshold',
        description: 'Mutations needed before a mechanics attractor promotes to spirit',
        step: 1,
    },
    expansionBudgetL0: {
        label: 'L0 Token Budget',
        description: 'Tokens spent per attractor at L0 (surface) resolution',
        step: 1,
    },
    expansionBudgetL1: {
        label: 'L1 Token Budget',
        description: 'Tokens spent per attractor at L1 (standard) resolution',
        step: 5,
    },
    expansionBudgetL2: {
        label: 'L2 Token Budget',
        description: 'Tokens spent per attractor at L2 (deep) resolution',
        step: 10,
    },
    ghostDisplacementThreshold: {
        label: 'Ghost Displacement Threshold',
        description: 'Distance under which nearby attractors archive as ghosts (higher = more aggressive pruning)',
        step: 0.01,
    },
}

interface Preset {
    id: string
    name: string
    icon: typeof Scale
    blurb: string
    values: SclConfig
}

// Presets validated against SCL core semantics:
// - spiritDriftThreshold: LOW = strict drift rejection, HIGH = permissive refinements
// - promotionMutationCount: LOW = fast promotion, HIGH = slow promotion
// - expansionBudget L0/L1/L2: tokens per attractor (LOW = more attractors fit shallowly, HIGH = fewer attractors richer)
// - ghostDisplacementThreshold: LOW = rarely archive (mechanics linger), HIGH = aggressively archive (replace fast)
const PRESETS: Preset[] = [
    {
        id: 'balanced',
        name: 'Balanced',
        icon: Scale,
        blurb: 'Sensible defaults. Moderate drift protection, standard promotions, medium budgets.',
        values: {
            spiritDriftThreshold: 0.15,
            promotionMutationCount: 5,
            expansionBudgetL0: 10,
            expansionBudgetL1: 50,
            expansionBudgetL2: 500,
            ghostDisplacementThreshold: 0.3,
        },
    },
    {
        id: 'conservative',
        name: 'Conservative',
        icon: Shield,
        blurb: 'Strict spirit protection, slow promotions, rarely prunes. Stable, slow-changing knowledge.',
        values: {
            spiritDriftThreshold: 0.08,
            promotionMutationCount: 15,
            expansionBudgetL0: 8,
            expansionBudgetL1: 30,
            expansionBudgetL2: 200,
            ghostDisplacementThreshold: 0.15,
        },
    },
    {
        id: 'adaptive',
        name: 'Adaptive',
        icon: Zap,
        blurb: 'Fast learning, aggressive promotions, larger budgets. Lattice evolves quickly.',
        values: {
            spiritDriftThreshold: 0.25,
            promotionMutationCount: 3,
            expansionBudgetL0: 15,
            expansionBudgetL1: 80,
            expansionBudgetL2: 800,
            ghostDisplacementThreshold: 0.35,
        },
    },
    {
        id: 'deep-thinker',
        name: 'Deep Thinker',
        icon: Brain,
        blurb: 'Maximum context per attractor, richer reasoning. Great for research-heavy work.',
        values: {
            spiritDriftThreshold: 0.15,
            promotionMutationCount: 5,
            expansionBudgetL0: 20,
            expansionBudgetL1: 100,
            expansionBudgetL2: 1500,
            ghostDisplacementThreshold: 0.2,
        },
    },
    {
        id: 'fast-light',
        name: 'Fast & Light',
        icon: Rocket,
        blurb: 'Minimal cost per attractor, cheap execution. Simple tasks, low-overhead operation.',
        values: {
            spiritDriftThreshold: 0.2,
            promotionMutationCount: 7,
            expansionBudgetL0: 5,
            expansionBudgetL1: 25,
            expansionBudgetL2: 200,
            ghostDisplacementThreshold: 0.3,
        },
    },
    {
        id: 'experimental',
        name: 'Experimental',
        icon: FlaskConical,
        blurb: 'Permissive drift, fast promotions, aggressive pruning. Watch the lattice mutate freely.',
        values: {
            spiritDriftThreshold: 0.35,
            promotionMutationCount: 2,
            expansionBudgetL0: 12,
            expansionBudgetL1: 60,
            expansionBudgetL2: 600,
            ghostDisplacementThreshold: 0.5,
        },
    },
]

const EXPLAINER: Record<keyof SclConfig, string> = {
    spiritDriftThreshold:
        'Spirit anchors are your stable, protected concepts. This sets how far a new mutation can drift from an anchor before it gets flagged as a drift warning instead of silently applied. Lower = stricter protection. Raise it if you want spirits to evolve more freely.',
    promotionMutationCount:
        'Mechanics attractors (working concepts) get promoted to spirit (stable anchors) after this many mutations. Lower = the lattice crystallizes fast. Higher = only concepts that survive many rounds earn anchor status.',
    expansionBudgetL0:
        'L0 is the shallowest expansion level — fast, surface-level context. This sets tokens spent per attractor at L0. Lower means more attractors fit in a fixed context window, each barely sketched. Higher means fewer, slightly richer.',
    expansionBudgetL1:
        'L1 is the standard expansion level used for most reasoning. Tokens per attractor here controls the depth/breadth tradeoff. This is the dial most workflows actually feel.',
    expansionBudgetL2:
        'L2 is the deepest expansion level — used for heavy reasoning, long-context tasks. Tokens per attractor here can be large; raise for research-grade depth, lower to keep deep expansions cheap.',
    ghostDisplacementThreshold:
        'When a new concept lands near an existing mechanics attractor, the old one gets archived as a ghost if it is within this distance. Higher = more aggressive pruning (lattice stays lean). Lower = older concepts linger even when similar new ones arrive.',
}

function configsEqual(a: SclConfig, b: SclConfig): boolean {
    const keys = Object.keys(a) as Array<keyof SclConfig>
    return keys.every(k => Math.abs(a[k] - b[k]) < 1e-9)
}

export function SclConfigPanel({ workspaceId }: { workspaceId: string }) {
    const [config, setConfig] = useState<SclConfig | null>(null)
    const [defaults, setDefaults] = useState<SclConfig | null>(null)
    const [bounds, setBounds] = useState<Record<string, Bounds>>({})
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [explainerOpen, setExplainerOpen] = useState(false)
    const explainerTrapRef = useFocusTrap<HTMLDivElement>(explainerOpen)

    const fetchConfig = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl/config?workspaceId=${workspaceId}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as ConfigResponse
            setConfig(data.config)
            setDefaults(data.defaults)
            setBounds(data.bounds)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load config')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchConfig() }, [fetchConfig])

    const activePresetId = useMemo(() => {
        if (!config) return null
        const match = PRESETS.find(p => configsEqual(p.values, config))
        return match?.id ?? null
    }, [config])

    async function handleSave() {
        if (!config) return
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/scl/config`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, ...config }),
            })
            if (!res.ok) {
                const data = await res.json() as { error?: { message?: string } }
                throw new Error(data.error?.message ?? `HTTP ${res.status}`)
            }
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    function resetToDefaults() {
        if (defaults) setConfig({ ...defaults })
    }

    function applyPreset(preset: Preset) {
        setConfig({ ...preset.values })
    }

    if (loading) {
        return <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading SCL configuration...</div>
    }

    if (!config) return null

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Settings2 className="h-4 w-4 text-purple-400" />
                    <h3 className="text-sm font-bold text-text-primary">SCL Tuning</h3>
                    <button
                        type="button"
                        onClick={() => setExplainerOpen(true)}
                        className="flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary hover:border-border transition-colors"
                        aria-label="What do these do?"
                    >
                        <HelpCircle className="h-3 w-3" />
                        What do these do?
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={resetToDefaults}
                        className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                    >
                        Reset defaults
                    </button>
                    <button
                        onClick={() => void handleSave()}
                        disabled={saving}
                        className="flex items-center gap-1.5 rounded-lg bg-azure px-3 py-1.5 text-xs font-medium text-white hover:bg-azure/90 disabled:opacity-50"
                    >
                        {saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : saved ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                        {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
                    </button>
                </div>
            </div>

            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Quick presets</span>
                    <span className="text-[10px] text-text-muted">
                        {activePresetId
                            ? `(${PRESETS.find(p => p.id === activePresetId)?.name})`
                            : '(Custom)'}
                    </span>
                </div>
                <div className="flex flex-wrap gap-2">
                    {PRESETS.map(preset => {
                        const Icon = preset.icon
                        const active = activePresetId === preset.id
                        return (
                            <button
                                key={preset.id}
                                type="button"
                                onClick={() => applyPreset(preset)}
                                title={preset.blurb}
                                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                    active
                                        ? 'border-azure bg-azure/15 text-text-primary'
                                        : 'border-border bg-surface-1/40 text-text-muted hover:text-text-primary hover:border-border/80'
                                }`}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {preset.name}
                            </button>
                        )
                    })}
                </div>
            </div>

            {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-dim px-3 py-2 text-xs text-red">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            <div className="grid gap-3">
                {(Object.keys(LABELS) as Array<keyof SclConfig>).map(key => {
                    const meta = LABELS[key]
                    const bound = bounds[key]
                    const value = config[key]

                    return (
                        <div key={key} className="rounded-lg border border-border bg-surface-1/40 p-3 space-y-1.5">
                            <div className="flex items-center justify-between">
                                <label className="text-xs font-medium text-text-primary">{meta.label}</label>
                                <input
                                    type="number"
                                    value={value}
                                    min={bound?.min}
                                    max={bound?.max}
                                    step={meta.step}
                                    onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })}
                                    className="w-20 rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary text-right focus:border-azure focus-ring"
                                />
                            </div>
                            <p className="text-[11px] text-text-muted">{meta.description}</p>
                            {bound && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-text-muted">{bound.min}</span>
                                    <input
                                        type="range"
                                        value={value}
                                        min={bound.min}
                                        max={bound.max}
                                        step={meta.step}
                                        onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })}
                                        className="flex-1 h-1 accent-purple-400"
                                    />
                                    <span className="text-[10px] text-text-muted">{bound.max}</span>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {explainerOpen && (
                <div
                    ref={explainerTrapRef}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-label="SCL tuning explainer"
                    onClick={() => setExplainerOpen(false)}
                >
                    <div
                        className="w-full max-w-xl max-h-[85vh] overflow-auto rounded-lg border border-border bg-surface-1 p-6 shadow-xl"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between">
                            <div>
                                <h2 className="text-base font-semibold text-text-primary">What do these do?</h2>
                                <p className="mt-1 text-xs text-text-muted">
                                    Quick plain-language tour of each SCL tuning parameter.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setExplainerOpen(false)}
                                className="rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface-1"
                                aria-label="Close"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3">
                            {(Object.keys(LABELS) as Array<keyof SclConfig>).map(key => (
                                <div key={key} className="rounded-md border border-border/60 bg-canvas/40 p-3">
                                    <div className="text-xs font-semibold text-text-primary">{LABELS[key].label}</div>
                                    <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{EXPLAINER[key]}</p>
                                </div>
                            ))}
                        </div>

                        <button
                            type="button"
                            onClick={() => setExplainerOpen(false)}
                            className="mt-4 w-full rounded-lg bg-azure px-4 py-2 text-xs font-medium text-white hover:bg-azure/90"
                        >
                            Got it
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
