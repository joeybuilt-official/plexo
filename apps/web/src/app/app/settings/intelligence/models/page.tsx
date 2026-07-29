// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Models catalog browser — Phase 2b sub-page.
 *
 * Browse the 506-row models_knowledge catalog with filters (provider,
 * capability, strength, cost, latency) and sort (score / cost / context /
 * name). Each card uses ModelAttributeBadges so the catalog and the
 * chain editor render identically.
 *
 * Lives at /app/settings/intelligence/models so the existing Routing
 * surface (chain editor + cost ceiling) stays the primary scroll —
 * the catalog is the deeper "browse everything" view.
 */

import { useState } from 'react'
import { AlertCircle, Boxes, Loader2, RefreshCw, SearchX } from 'lucide-react'
import { useModelCatalog } from '@web/lib/intelligence-client'
import { ModelAttributeBadges, type ModelAttributesView } from '../model-attribute-badges'
import { FiltersSidebar } from './filters-sidebar'
import type { CatalogFilters } from './filters-sidebar'
import { RefreshButton } from './refresh-button'

export default function ModelCatalogPage() {
    const [filters, setFilters] = useState<CatalogFilters>({
        provider: '',
        capability: '',
        strength: '',
        cost: '',
        latency: '',
        q: '',
        sort: 'score',
    })
    const [page, setPage] = useState(0)
    const pageSize = 50

    const { data, isLoading, error, mutate } = useModelCatalog({
        ...filters,
        page,
        pageSize,
    })

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-sm bg-surface-1 flex items-center justify-center shrink-0">
                        <Boxes className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-text-primary">Model catalog</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Browse the {data?.total ?? 506} models in the routing knowledge base.
                        </p>
                    </div>
                </div>
                <div className="shrink-0">
                    <RefreshButton onRefreshed={() => void mutate()} />
                </div>
            </div>

            <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
                <div className="w-full md:w-60 md:flex-shrink-0 border-b md:border-b-0 md:border-r border-border overflow-y-auto p-3">
                    <FiltersSidebar
                        filters={filters}
                        onChange={(next: CatalogFilters) => { setFilters(next); setPage(0) }}
                    />
                </div>

                <div className="flex-1 overflow-y-auto p-4">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12 text-xs text-text-muted">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading catalog…
                        </div>
                    ) : error ? (
                        <div role="alert" className="flex items-start gap-3 rounded-sm border border-rose-700/40 bg-surface-1 p-4 text-xs text-rose-300">
                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                            <div className="flex-1">
                                <p className="font-medium">Failed to load catalog</p>
                                <p className="mt-0.5 text-rose-400/70">{String(error)}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void mutate()}
                                className="shrink-0 flex items-center gap-1 rounded-md border border-rose-700/40 px-2 py-1 hover:bg-rose-900/20 transition-colors"
                                aria-label="Retry loading catalog"
                            >
                                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                                Retry
                            </button>
                        </div>
                    ) : !data || data.items.length === 0 ? (
                        <div role="status" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                            <SearchX className="h-10 w-10 text-text-muted" aria-hidden="true" />
                            <div>
                                <p className="text-sm font-medium text-text-secondary">No models match these filters</p>
                                <p className="text-xs text-text-muted mt-1">Try adjusting your filters or search query.</p>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="grid gap-2 lg:grid-cols-2">
                                {data.items.map(item => {
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
                                            className="rounded-sm border border-border bg-surface-1 p-3"
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-sm font-medium text-text-primary truncate">{item.modelId}</div>
                                                    <div className="text-[11px] text-text-muted">{item.provider}</div>
                                                </div>
                                                <div className="text-[11px] text-text-muted tabular-nums">
                                                    {item.reliabilityScore.toFixed(2)}
                                                </div>
                                            </div>
                                            <div className="mt-2">
                                                <ModelAttributeBadges attributes={view} />
                                            </div>
                                            {item.bestForHint && (
                                                <p className="mt-2 text-[11px] text-text-muted leading-snug">{item.bestForHint}</p>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>

                            <div className="mt-4 flex items-center justify-between text-xs text-text-muted">
                                <span>Showing {data.items.length} of {data.total}</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        disabled={page === 0}
                                        onClick={() => setPage(p => Math.max(0, p - 1))}
                                        aria-label="Previous page"
                                        className="rounded-md border border-border bg-surface-1 px-2 py-1 disabled:opacity-30"
                                    >
                                        Prev
                                    </button>
                                    <span aria-live="polite" aria-atomic="true">page {page + 1}</span>
                                    <button
                                        type="button"
                                        disabled={(page + 1) * pageSize >= data.total}
                                        onClick={() => setPage(p => p + 1)}
                                        aria-label="Next page"
                                        className="rounded-md border border-border bg-surface-1 px-2 py-1 disabled:opacity-30"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
