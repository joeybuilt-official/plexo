// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { Brain, ChevronDown, ChevronRight, Shield, Zap, Layers, Loader2 } from 'lucide-react'
import { MindsetObjectViewer } from '@web/components/scl/MindsetObjectViewer'
import type { MindsetObject } from '@web/components/scl/MindsetObjectViewer'

/** Golden Record expansion result (scl/1.0) */
interface TaskExpansionResult {
    expanded: boolean
    reason?: string
    contextBlock?: string
    tokenCount?: number
    regionsActivated?: string[]
    attractorIds?: string[]
    attractorsExpanded?: number
}

/** Legacy expansion format (scl/0.2) */
interface LegacyExpansion {
    relevantPatterns?: string[]
    suggestedTools?: string[]
    tokenCount?: number
    sourceRegions?: string[]
}

interface SclDisclosureProps {
    taskId: string
    workspaceId: string
    domainRegion: string | null
}

export function SclDisclosure({ taskId, workspaceId, domainRegion }: SclDisclosureProps) {
    const [open, setOpen] = useState(false)
    const [expansion, setExpansion] = useState<TaskExpansionResult | null>(null)
    const [legacy, setLegacy] = useState<LegacyExpansion | null>(null)
    const [mindset, setMindset] = useState<MindsetObject | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [sclLoading, setSclLoading] = useState(false)

    useEffect(() => {
        if (!open || loaded) return
        setLoaded(true)
        setSclLoading(true)

        const apiBase = ''
        Promise.allSettled([
            fetch(`${apiBase}/api/v1/scl-admin/expand`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, stimulus: taskId }),
            }).then(r => r.ok ? r.json() : null),
            fetch(`${apiBase}/api/v1/scl-admin/mindset/${workspaceId}`).then(r => r.ok ? r.json() : null),
        ]).then(([expRes, mindRes]) => {
            setSclLoading(false)
            if (expRes.status === 'fulfilled' && expRes.value) {
                const data = expRes.value
                // Detect format: Golden Record has `expanded` boolean
                if ('expanded' in data) {
                    setExpansion(data as TaskExpansionResult)
                } else if ('expansion' in data) {
                    // Wrapped legacy format
                    setLegacy(data.expansion as LegacyExpansion)
                } else {
                    // Raw legacy
                    setLegacy(data as LegacyExpansion)
                }
            }
            if (mindRes.status === 'fulfilled' && mindRes.value) {
                setMindset(mindRes.value.mindset ?? mindRes.value)
            }
        })
    }, [open, loaded, workspaceId, taskId])

    if (!domainRegion) return null

    return (
        <div className="rounded-sm border border-border/60 bg-surface-1/40 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-text-muted hover:text-text-secondary transition-colors"
            >
                <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>What Plexo knew about this task</span>
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0" aria-hidden="true" />
                    : <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0" aria-hidden="true" />}
            </button>

            {open && (
                <div className="border-t border-border/40 px-4 py-3 space-y-3">
                    {sclLoading && (
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            Loading context data…
                        </div>
                    )}
                    <div data-testid="task-domain-region">
                        <span className="text-xs font-medium text-text-secondary">Domain:</span>{' '}
                        <span className="text-xs text-text-muted">{domainRegion}</span>
                    </div>

                    {/* Golden Record expansion (scl/1.0) */}
                    {expansion && expansion.expanded && (
                        <div className="space-y-2">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                <MiniStat icon={Layers} label="Regions" value={expansion.regionsActivated?.length ?? 0} />
                                <MiniStat icon={Zap} label="Attractors" value={expansion.attractorsExpanded ?? 0} />
                                <MiniStat icon={Brain} label="Tokens" value={expansion.tokenCount ?? 0} />
                                <MiniStat icon={Shield} label="IDs matched" value={expansion.attractorIds?.length ?? 0} />
                            </div>

                            {(expansion.regionsActivated?.length ?? 0) > 0 && (
                                <div>
                                    <span className="text-xs font-medium text-text-secondary">Regions activated:</span>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {expansion.regionsActivated!.map(r => (
                                            <span key={r} className="rounded border border-azure-800/30 bg-azure/10 px-2 py-0.5 text-[11px] text-azure">{r}</span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {expansion && !expansion.expanded && (
                        <p className="text-xs text-text-muted">{expansion.reason ?? 'SCL expansion not available for this task.'}</p>
                    )}

                    {/* Legacy expansion (scl/0.2) */}
                    {legacy && (
                        <>
                            {(legacy.relevantPatterns?.length ?? 0) > 0 && (
                                <div>
                                    <span className="text-xs font-medium text-text-secondary">Patterns matched:</span>
                                    <ul className="mt-1 ml-4 list-disc">
                                        {legacy.relevantPatterns!.slice(0, 3).map((p, i) => (
                                            <li key={i} className="text-xs text-text-muted">{p}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(legacy.suggestedTools?.length ?? 0) > 0 && (
                                <div>
                                    <span className="text-xs font-medium text-text-secondary">Suggested tools:</span>{' '}
                                    <span className="text-xs text-text-muted">{legacy.suggestedTools!.join(', ')}</span>
                                </div>
                            )}
                            {legacy.tokenCount != null && (
                                <div className="text-[11px] text-text-muted">
                                    Context: {legacy.tokenCount} tokens (SCL-compressed)
                                </div>
                            )}
                        </>
                    )}

                    <MindsetObjectViewer
                        mindset={mindset}
                        activatedRegion={domainRegion}
                        className="h-48"
                    />
                </div>
            )}
        </div>
    )
}

function MiniStat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
    return (
        <div className="rounded-sm border border-border/40 bg-canvas px-2 py-1.5">
            <div className="flex items-center gap-1">
                <Icon className="h-2.5 w-2.5 text-text-muted" />
                <span className="text-[10px] text-text-muted uppercase tracking-wider">{label}</span>
            </div>
            <span className="text-sm font-medium text-text-primary">{value}</span>
        </div>
    )
}
