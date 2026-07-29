// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * CostCeilingSlider — Phase 2a routing UI.
 *
 * Workspace-level monthly cost ceiling with:
 *   - log-scale slider 0..$1000
 *   - live "spent so far this month" display from /spend
 *   - soft / hard enforcement toggle
 *   - inline 80%/100% banners when warn or block state is hit
 *
 * The slider commits on input release (onChange) so we don't hammer the
 * PATCH endpoint every pixel. The mode toggle commits immediately.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ShieldAlert, Loader2 } from 'lucide-react'
import {
    useIntelligenceSettings,
    useWorkspaceSpend,
    patchCostCeiling,
    type CostCeilingMode,
} from '@web/lib/intelligence-client'

// ── Slider scale (log) ────────────────────────────────────────────────────
// 0 → no ceiling, 1..100 → $1..$1000 mapped log-scaled.

const STEPS = 100
function sliderToUsd(step: number): number | null {
    if (step <= 0) return null
    const minLog = Math.log10(1)
    const maxLog = Math.log10(1000)
    const log = minLog + ((step - 1) / (STEPS - 1)) * (maxLog - minLog)
    return Math.round(Math.pow(10, log))
}
function usdToSlider(usd: number | null): number {
    if (usd == null || usd <= 0) return 0
    const minLog = Math.log10(1)
    const maxLog = Math.log10(1000)
    const log = Math.log10(Math.max(1, Math.min(1000, usd)))
    return Math.round(((log - minLog) / (maxLog - minLog)) * (STEPS - 1)) + 1
}

function formatUsd(n: number): string {
    if (n >= 100) return `$${Math.round(n)}`
    return `$${n.toFixed(2)}`
}

export function CostCeilingSlider({ workspaceId }: { workspaceId: string }) {
    const { data: settingsData, mutate: mutateSettings } = useIntelligenceSettings(workspaceId)
    const { data: spendData, mutate: mutateSpend } = useWorkspaceSpend(workspaceId)

    const ceilingUsd = settingsData?.settings.costCeilingUsd ?? null
    const mode: CostCeilingMode = settingsData?.settings.costCeilingMode ?? 'soft_warn'

    const [draft, setDraft] = useState<number>(usdToSlider(ceilingUsd))
    const [saving, setSaving] = useState(false)

    // Re-sync draft when server value changes (e.g. another tab updates)
    useEffect(() => {
        setDraft(usdToSlider(ceilingUsd))
    }, [ceilingUsd])

    const draftUsd = sliderToUsd(draft)
    const spentUsd = spendData?.spend.pricedUsd ?? 0
    const usagePct = spendData?.ceiling.usagePct ?? 0
    const ceilingState = spendData?.ceiling.state ?? 'ok'

    async function commitCeiling(value: number | null) {
        setSaving(true)
        try {
            await patchCostCeiling(workspaceId, { ceilingUsd: value })
            await Promise.all([mutateSettings(), mutateSpend()])
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update ceiling')
        } finally {
            setSaving(false)
        }
    }

    async function commitMode(next: CostCeilingMode) {
        setSaving(true)
        try {
            await patchCostCeiling(workspaceId, { mode: next })
            await mutateSettings()
            const label = next === 'hard_block' ? 'hard block' : next === 'off' ? 'off (provider caps)' : 'soft warn'
            toast.success(`Enforcement set to ${label}`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update enforcement')
        } finally {
            setSaving(false)
        }
    }

    const usagePctClamped = Math.min(100, Math.max(0, usagePct * 100))
    const barColor =
        ceilingState === 'block' ? 'bg-rose-500'
        : ceilingState === 'warn' ? 'bg-amber-400'
        : 'bg-signal-green'

    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-sm font-medium text-text-primary">Monthly cost ceiling</h3>
                <p className="text-xs text-text-muted">
                    Cap how much your workspace can spend on inference each calendar month.
                </p>
            </div>

            {/* Banners */}
            {ceilingState === 'warn' && ceilingUsd != null && (
                <div className="flex items-start gap-2 rounded-sm border border-amber-700/40 bg-surface-1 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-400 flex-shrink-0" />
                    <div className="text-xs text-text-primary">
                        <span className="font-medium">Approaching the ceiling.</span>{' '}
                        Spent {formatUsd(spentUsd)} of {formatUsd(ceilingUsd)} ({Math.round(usagePctClamped)}%).
                    </div>
                </div>
            )}
            {ceilingState === 'block' && ceilingUsd != null && (
                <div className="flex items-start gap-2 rounded-sm border border-rose-700/40 bg-surface-1 p-3">
                    <ShieldAlert className="mt-0.5 h-4 w-4 text-rose-400 flex-shrink-0" />
                    <div className="text-xs text-text-primary">
                        <span className="font-medium">Ceiling reached.</span>{' '}
                        Spent {formatUsd(spentUsd)} of {formatUsd(ceilingUsd)}. New tasks are being blocked
                        because enforcement is set to hard block.
                    </div>
                </div>
            )}

            {/* Spend bar */}
            <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span>Spent this month</span>
                    <span>
                        <span className="text-text-primary">{formatUsd(spentUsd)}</span>
                        {ceilingUsd != null && (
                            <> / {formatUsd(ceilingUsd)}</>
                        )}
                    </span>
                </div>
                <div className="h-2 w-full rounded-full bg-surface-1 border border-border overflow-hidden">
                    {ceilingUsd != null && (
                        <div
                            className={`h-full transition-all ${barColor}`}
                            style={{ width: `${usagePctClamped}%` }}
                        />
                    )}
                </div>
            </div>

            {/* Slider */}
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <label className="text-xs text-text-muted">Ceiling</label>
                    <span className="text-xs text-text-primary font-mono">
                        {draftUsd == null ? 'No ceiling' : formatUsd(draftUsd) + '/mo'}
                    </span>
                </div>
                <input
                    type="range"
                    aria-label="Monthly cost ceiling"
                    min={0}
                    max={STEPS}
                    value={draft}
                    onChange={(e) => setDraft(parseInt(e.target.value, 10))}
                    onMouseUp={() => void commitCeiling(sliderToUsd(draft))}
                    onTouchEnd={() => void commitCeiling(sliderToUsd(draft))}
                    onKeyUp={(e) => {
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                            void commitCeiling(sliderToUsd(draft))
                        }
                    }}
                    disabled={saving}
                    className="w-full accent-azure disabled:opacity-50"
                />
                <div className="flex items-center justify-between text-[10px] text-text-muted">
                    <span>None</span>
                    <span>$1</span>
                    <span>$10</span>
                    <span>$100</span>
                    <span>$1000</span>
                </div>
            </div>

            {/* Enforcement mode toggle */}
            <div className="space-y-1.5">
                <label className="text-xs text-text-muted">Enforcement</label>
                <div className="grid grid-cols-3 gap-2">
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => void commitMode('soft_warn')}
                        aria-pressed={mode === 'soft_warn'}
                        className={`rounded-sm border px-3 py-2 text-left text-xs transition-colors ${
                            mode === 'soft_warn'
                                ? 'border-azure bg-surface-1 ring-1 ring-azure/40'
                                : 'border-border bg-surface-1 hover:border-muted'
                        } disabled:opacity-50`}
                    >
                        <div className="font-medium text-text-primary">Soft warn</div>
                        <div className="mt-0.5 text-[11px] text-text-muted">Banner at 80% and 100%, never blocks.</div>
                    </button>
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => void commitMode('hard_block')}
                        aria-pressed={mode === 'hard_block'}
                        className={`rounded-sm border px-3 py-2 text-left text-xs transition-colors ${
                            mode === 'hard_block'
                                ? 'border-azure bg-surface-1 ring-1 ring-azure/40'
                                : 'border-border bg-surface-1 hover:border-muted'
                        } disabled:opacity-50`}
                    >
                        <div className="font-medium text-text-primary">Hard block</div>
                        <div className="mt-0.5 text-[11px] text-text-muted">Returns 402 once the ceiling is reached.</div>
                    </button>
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => void commitMode('off')}
                        aria-pressed={mode === 'off'}
                        className={`rounded-sm border px-3 py-2 text-left text-xs transition-colors ${
                            mode === 'off'
                                ? 'border-azure bg-surface-1 ring-1 ring-azure/40'
                                : 'border-border bg-surface-1 hover:border-muted'
                        } disabled:opacity-50`}
                    >
                        <div className="font-medium text-text-primary">Off</div>
                        <div className="mt-0.5 text-[11px] text-text-muted">Trust provider caps. No in-app warn or block.</div>
                    </button>
                </div>
            </div>

            {saving && (
                <div className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                </div>
            )}
        </div>
    )
}
