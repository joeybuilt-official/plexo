// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Attractor browser — Phase 3b sub-page.
 *
 * Lists `scl_concept_graphs` rows for the current workspace, filterable
 * by domain region and free-text query against id/region. Clicking a
 * row opens the inline detail panel which fetches the full graph_json
 * + mindset_object via /api/v1/scl/attractors/:id.
 *
 * v1 detail viewer is a JSON tree (collapsible). v2 (post-Phase 3b)
 * could swap in a mermaid graph viz, but the spec calls for "basic
 * JSON viewer for v1; mermaid graph viz for v2 if there's time" — we
 * keep v1 here.
 */

import { useState } from 'react'
import { Loader2, Search, Network } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useAttractors, useAttractor, useSclDomainRegions } from '@web/lib/scl-client'

export default function AttractorBrowserPage() {
    const { workspaceId } = useWorkspace()
    const [domain, setDomain] = useState('')
    const [query, setQuery] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)

    const { data: regionsData } = useSclDomainRegions(workspaceId || null)
    const { data, isLoading, error } = useAttractors(workspaceId || null, {
        domain: domain || undefined,
        query: query || undefined,
        limit: 100,
    })
    const { data: detailData, isLoading: detailLoading } = useAttractor(workspaceId || null, selectedId)

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-surface-1 flex items-center justify-center shrink-0">
                        <Network className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-text-primary">Attractor browser</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Per-task concept graphs extracted from inference logs. Click a row to inspect the graph JSON.
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
                <div className="w-1/2 flex flex-col border-r border-border overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-border p-3">
                        <div className="relative flex-1">
                            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
                            <input
                                type="text"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search id or region…"
                                className="w-full rounded-md border border-border bg-surface-1 px-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus-ring focus:ring-1 focus:ring-azure"
                            />
                        </div>
                        <select
                            value={domain}
                            onChange={e => setDomain(e.target.value)}
                            className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                        >
                            <option value="">All regions</option>
                            {(regionsData?.regions ?? []).map(r => (
                                <option key={r.region} value={r.region}>
                                    {r.region} ({r.count})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3">
                        {!workspaceId ? (
                            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                                Pick a workspace.
                            </div>
                        ) : isLoading ? (
                            <div className="flex items-center justify-center py-12 text-xs text-text-muted">
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
                            </div>
                        ) : error ? (
                            <div className="rounded-xl border border-rose-700/40 bg-surface-1 p-3 text-xs text-rose-300">
                                Failed to load. {String(error)}
                            </div>
                        ) : !data || data.attractors.length === 0 ? (
                            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                                No attractors match.
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {data.attractors.map(a => {
                                    const active = selectedId === a.id
                                    return (
                                        <button
                                            key={a.id}
                                            type="button"
                                            onClick={() => setSelectedId(a.id)}
                                            className={`w-full rounded-md border bg-surface-1 p-2 text-left text-xs transition-colors ${
                                                active
                                                    ? 'border-azure ring-1 ring-azure/40'
                                                    : 'border-border hover:border-muted'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-text-primary truncate font-mono text-[11px]">
                                                    {a.id.slice(0, 8)}…{a.id.slice(-4)}
                                                </span>
                                                {a.domainRegion && (
                                                    <span className="text-[10px] text-text-muted">{a.domainRegion}</span>
                                                )}
                                            </div>
                                            <div className="mt-0.5 text-[10px] text-text-muted">
                                                {new Date(a.createdAt).toLocaleString()}
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                    {!selectedId ? (
                        <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                            Select an attractor on the left to inspect its concept graph.
                        </div>
                    ) : detailLoading ? (
                        <div className="flex items-center justify-center py-12 text-xs text-text-muted">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading detail…
                        </div>
                    ) : !detailData ? (
                        <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                            Attractor not found.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="rounded-xl border border-border bg-surface-1 p-3">
                                <div className="text-[11px] text-text-muted">id</div>
                                <div className="font-mono text-[11px] text-text-primary break-all">
                                    {detailData.attractor.id}
                                </div>
                                {detailData.attractor.domainRegion && (
                                    <>
                                        <div className="mt-2 text-[11px] text-text-muted">domain region</div>
                                        <div className="text-xs text-text-primary">{detailData.attractor.domainRegion}</div>
                                    </>
                                )}
                                {detailData.attractor.sourceLogId && (
                                    <>
                                        <div className="mt-2 text-[11px] text-text-muted">source log</div>
                                        <div className="font-mono text-[11px] text-text-primary break-all">
                                            {detailData.attractor.sourceLogId}
                                        </div>
                                    </>
                                )}
                                <div className="mt-2 text-[11px] text-text-muted">created</div>
                                <div className="text-xs text-text-primary">
                                    {new Date(detailData.attractor.createdAt).toLocaleString()}
                                </div>
                            </div>
                            <div className="rounded-xl border border-border bg-surface-1 p-3">
                                <div className="text-[11px] uppercase tracking-wide text-text-muted">graph_json</div>
                                <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-border bg-surface-1 p-2 text-[10px] text-text-primary">
{JSON.stringify(detailData.attractor.graphJson, null, 2)}
                                </pre>
                            </div>
                            {detailData.attractor.mindsetObject && (
                                <div className="rounded-xl border border-border bg-surface-1 p-3">
                                    <div className="text-[11px] uppercase tracking-wide text-text-muted">mindset_object</div>
                                    <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-border bg-surface-1 p-2 text-[10px] text-text-primary">
{JSON.stringify(detailData.attractor.mindsetObject, null, 2)}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
