// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * ModelPickerModal — Phase 2b chain editor add-model dialog.
 *
 * Filterable picker driven by the /api/v1/models/catalog endpoint.
 * Lets a user choose any catalog model and the workspace's enabled
 * provider that exposes it. Confirming the picker calls back into
 * the chain editor with `{ providerId, modelId }`.
 *
 * Filters mirror the catalog browser sidebar (Phase 2b's other surface)
 * but live inline because the picker is a modal over the editor.
 */

import { useState, useMemo } from 'react'
import { X, Loader2, Search } from 'lucide-react'
import { useModelCatalog, type CatalogItemView } from '@web/lib/intelligence-client'
import { ModelAttributeBadges, type ModelAttributesView } from '../model-attribute-badges'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

export interface ProviderInstanceLite {
    id: string
    providerType: string
    enabled: boolean
    chatModels: string[]
}

interface ModelPickerModalProps {
    open: boolean
    onClose: () => void
    providers: ProviderInstanceLite[]
    onPick: (entry: { providerId: string; modelId: string }) => void
}

export function ModelPickerModal({ open, onClose, providers, onPick }: ModelPickerModalProps) {
    const [search, setSearch] = useState('')
    const [providerFilter, setProviderFilter] = useState<string>('')
    const [costFilter, setCostFilter] = useState<string>('')
    const [latencyFilter, setLatencyFilter] = useState<string>('')

    const { data, isLoading } = useModelCatalog({
        q: search || undefined,
        provider: providerFilter || undefined,
        cost: costFilter || undefined,
        latency: latencyFilter || undefined,
        pageSize: 100,
    })

    // Index of provider instances by providerType so we know which ones
    // can serve a given catalog row.
    const providersByType = useMemo(() => {
        const map = new Map<string, ProviderInstanceLite[]>()
        for (const p of providers) {
            if (!p.enabled) continue
            if (!map.has(p.providerType)) map.set(p.providerType, [])
            map.get(p.providerType)!.push(p)
        }
        return map
    }, [providers])

    const trapRef = useFocusTrap<HTMLDivElement>(open)

    if (!open) return null

    function handlePick(item: CatalogItemView, providerId: string) {
        onPick({ providerId, modelId: item.modelId })
        onClose()
    }

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-picker-modal-title"
        >
            <div className="w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-xl border border-border bg-surface-1">
                <div className="flex items-center justify-between border-b border-border p-3">
                    <div>
                        <h2 id="model-picker-modal-title" className="text-sm font-medium text-text-primary">Add a model</h2>
                        <p className="text-[11px] text-text-muted">Pick from the 506-model catalog. Only enabled providers can serve a chain entry.</p>
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-text-primary"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex items-center gap-2 border-b border-border p-3">
                    <div className="relative flex-1">
                        <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search by model id…"
                            className="w-full rounded-md border border-border bg-surface-1 px-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus-ring focus:ring-1 focus:ring-azure"
                        />
                    </div>
                    <select
                        value={providerFilter}
                        onChange={e => setProviderFilter(e.target.value)}
                        className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                    >
                        <option value="">All providers</option>
                        {Array.from(providersByType.keys()).sort().map(p => (
                            <option key={p} value={p}>{p}</option>
                        ))}
                    </select>
                    <select
                        value={costFilter}
                        onChange={e => setCostFilter(e.target.value)}
                        className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                    >
                        <option value="">Any cost</option>
                        <option value="free">free</option>
                        <option value="cheap">cheap</option>
                        <option value="standard">standard</option>
                        <option value="premium">premium</option>
                    </select>
                    <select
                        value={latencyFilter}
                        onChange={e => setLatencyFilter(e.target.value)}
                        className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                    >
                        <option value="">Any speed</option>
                        <option value="fast">fast</option>
                        <option value="medium">medium</option>
                        <option value="slow">slow</option>
                    </select>
                </div>

                <div className="overflow-y-auto p-3" style={{ maxHeight: 'calc(80vh - 140px)' }}>
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8 text-xs text-text-muted">
                            <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading catalog…
                        </div>
                    ) : !data || data.items.length === 0 ? (
                        <div className="py-8 text-center text-xs text-text-muted">No matching models.</div>
                    ) : (
                        <div className="space-y-2">
                            {data.items.map(item => {
                                const candidates = providersByType.get(item.provider) ?? []
                                if (candidates.length === 0) return null
                                const view: ModelAttributesView = {
                                    provider: item.provider,
                                    modelId: item.modelId,
                                    capabilities: item.capabilities,
                                    strengths: item.strengths,
                                    latencyClass: item.latencyClass,
                                    costClass: item.costClass,
                                    contextWindow: item.contextWindow,
                                    blendedCostPerM: item.blendedCostPerM,
                                    bestForHint: item.bestForHint,
                                }
                                return (
                                    <div
                                        key={item.id}
                                        className="rounded-xl border border-border bg-surface-1 p-3"
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium text-text-primary truncate">{item.modelId}</div>
                                                <div className="text-[11px] text-text-muted">{item.provider}</div>
                                            </div>
                                            <div className="flex flex-shrink-0 gap-1">
                                                {candidates.map(c => (
                                                    <button
                                                        key={c.id}
                                                        type="button"
                                                        onClick={() => handlePick(item, c.id)}
                                                        className="rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-primary hover:border-azure"
                                                    >
                                                        Add via {c.providerType}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="mt-2">
                                            <ModelAttributeBadges attributes={view} compact />
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
                {data && (
                    <div className="border-t border-border p-2 text-center text-[11px] text-text-muted">
                        Showing {data.items.length} of {data.total} catalog models
                    </div>
                )}
            </div>
        </div>
    )
}
