// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * SCL settings form — Phase 3a.
 *
 * Single form rendering every SCL workspace tunable: enabled toggle,
 * drift threshold slider, expand depth/width sliders, domain region
 * multi-select. Each control persists immediately on change via
 * patchSclSettings — no separate "Save" button. Bounds + defaults come
 * from the GET /settings response so they stay in sync with the API.
 */

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
    useSclSettings,
    useSclDomainRegions,
    patchSclSettings,
    type SclSettingsView,
} from '@web/lib/scl-client'

interface SettingsFormProps {
    workspaceId: string
}

export function SclSettingsForm({ workspaceId }: SettingsFormProps) {
    const { data, mutate, isLoading } = useSclSettings(workspaceId)
    const { data: regionsData } = useSclDomainRegions(workspaceId)
    const [draft, setDraft] = useState<SclSettingsView | null>(null)
    const [pendingField, setPendingField] = useState<keyof SclSettingsView | null>(null)

    useEffect(() => {
        if (data?.settings) setDraft({ ...data.settings })
    }, [data])

    if (isLoading || !draft || !data) {
        return (
            <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                Loading SCL settings…
            </div>
        )
    }

    const bounds = data.bounds
    const regions = regionsData?.regions ?? []

    async function persist(patch: Partial<SclSettingsView>, field: keyof SclSettingsView) {
        setPendingField(field)
        try {
            const result = await patchSclSettings(workspaceId, patch)
            setDraft({ ...result.settings })
            await mutate()
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update SCL settings')
        } finally {
            setPendingField(null)
        }
    }

    function toggleRegion(region: string) {
        const current = draft!.domainRegions ?? []
        const next = current.includes(region)
            ? current.filter(r => r !== region)
            : [...current, region]
        setDraft({ ...draft!, domainRegions: next })
        void persist({ domainRegions: next.length === 0 ? null : next }, 'domainRegions')
    }

    return (
        <div className="space-y-6">
            {/* Drift threshold */}
            <div className="rounded-sm border border-border bg-surface-1 p-3">
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">Drift threshold</h3>
                        <p className="text-[11px] text-text-muted">
                            How far a concept centroid can shift before a drift warning is filed. Lower = more sensitive.
                        </p>
                    </div>
                    <span className="text-xs text-text-primary tabular-nums">
                        {draft.driftThreshold.toFixed(2)}
                    </span>
                </div>
                <input
                    type="range"
                    min={bounds.driftThreshold.min}
                    max={bounds.driftThreshold.max}
                    step={0.01}
                    value={draft.driftThreshold}
                    disabled={pendingField === 'driftThreshold'}
                    onChange={e => setDraft({ ...draft, driftThreshold: Number(e.target.value) })}
                    onMouseUp={() => void persist({ driftThreshold: draft.driftThreshold }, 'driftThreshold')}
                    onTouchEnd={() => void persist({ driftThreshold: draft.driftThreshold }, 'driftThreshold')}
                    className="mt-2 w-full"
                />
            </div>

            {/* Expand depth */}
            <div className="rounded-sm border border-border bg-surface-1 p-3">
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">Expand depth</h3>
                        <p className="text-[11px] text-text-muted">
                            How many hops the SCL graph walk takes when packing context. Higher = more recall, more tokens.
                        </p>
                    </div>
                    <span className="text-xs text-text-primary tabular-nums">{draft.expandDepth}</span>
                </div>
                <input
                    type="range"
                    min={bounds.expandDepth.min}
                    max={bounds.expandDepth.max}
                    step={1}
                    value={draft.expandDepth}
                    disabled={pendingField === 'expandDepth'}
                    onChange={e => setDraft({ ...draft, expandDepth: Number(e.target.value) })}
                    onMouseUp={() => void persist({ expandDepth: draft.expandDepth }, 'expandDepth')}
                    onTouchEnd={() => void persist({ expandDepth: draft.expandDepth }, 'expandDepth')}
                    className="mt-2 w-full"
                />
            </div>

            {/* Expand width */}
            <div className="rounded-sm border border-border bg-surface-1 p-3">
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">Expand width</h3>
                        <p className="text-[11px] text-text-muted">
                            Maximum nodes packed into the context block per expansion. Higher = denser context.
                        </p>
                    </div>
                    <span className="text-xs text-text-primary tabular-nums">{draft.expandWidth}</span>
                </div>
                <input
                    type="range"
                    min={bounds.expandWidth.min}
                    max={bounds.expandWidth.max}
                    step={5}
                    value={draft.expandWidth}
                    disabled={pendingField === 'expandWidth'}
                    onChange={e => setDraft({ ...draft, expandWidth: Number(e.target.value) })}
                    onMouseUp={() => void persist({ expandWidth: draft.expandWidth }, 'expandWidth')}
                    onTouchEnd={() => void persist({ expandWidth: draft.expandWidth }, 'expandWidth')}
                    className="mt-2 w-full"
                />
            </div>

            {/* Domain region picker */}
            <div className="rounded-sm border border-border bg-surface-1 p-3">
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">Domain regions</h3>
                        <p className="text-[11px] text-text-muted">
                            Scope SCL expansion to specific concept regions. Empty = all regions.
                        </p>
                    </div>
                    {pendingField === 'domainRegions' && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                    {regions.length === 0 ? (
                        <p className="text-[11px] text-text-muted">No regions discovered yet for this workspace.</p>
                    ) : (
                        regions.map(r => {
                            const active = draft.domainRegions?.includes(r.region) ?? false
                            return (
                                <button
                                    key={r.region}
                                    type="button"
                                    onClick={() => toggleRegion(r.region)}
                                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                        active
                                            ? 'border-azure bg-surface-1 text-azure'
                                            : 'border-border bg-surface-1 text-text-muted hover:text-text-primary'
                                    }`}
                                >
                                    {r.region} <span className="text-text-muted">·{r.count}</span>
                                </button>
                            )
                        })
                    )}
                </div>
            </div>

            {/* PII scrub toggle */}
            <div className="rounded-sm border border-border bg-surface-1 p-3">
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">PII scrub</h3>
                        <p className="text-[11px] text-text-muted">
                            Strip emails, phones, IDs, addresses, and other PII before SCL writes a row to inference_logs.
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={draft.piiScrubEnabled}
                        disabled={pendingField === 'piiScrubEnabled'}
                        onClick={() => void persist({ piiScrubEnabled: !draft.piiScrubEnabled }, 'piiScrubEnabled')}
                        className={`relative h-6 w-11 rounded-full border transition-colors ${
                            draft.piiScrubEnabled ? 'border-azure bg-azure/30' : 'border-border bg-surface-1'
                        } disabled:opacity-50`}
                    >
                        <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full transition-transform ${
                                draft.piiScrubEnabled ? 'translate-x-5 bg-azure' : 'translate-x-0.5 bg-text-muted'
                            }`}
                        />
                    </button>
                </div>
            </div>
        </div>
    )
}
