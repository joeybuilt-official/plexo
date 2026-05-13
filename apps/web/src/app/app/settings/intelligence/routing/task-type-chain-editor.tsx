// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * TaskTypeChainEditor — Phase 2b centerpiece.
 *
 * Renders an accordion with one section per task type. Each section is
 * a ranked list of ChainModelCards with up/down/remove controls plus
 * an "Add model" button that opens the picker. Save persists the chain
 * via patchChain. Reset re-seeds from the smart defaults.
 *
 * Loads:
 *   - chains:   /api/v1/intelligence/:ws/chains
 *   - providers: /api/v1/workspaces/:ws/providers (already shipped)
 *   - catalog:  /api/v1/models/catalog (so model rows show attribute badges
 *               even before the user opens the picker)
 *
 * The chain editor is the only Phase 2b surface that holds local state
 * — every other component is presentational. State is per-tier so a
 * pending edit on conversation doesn't lose user work on planning.
 */

import { useState, useMemo, useEffect } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { ChevronDown, ChevronRight, Plus, RotateCcw, Save, Loader2 } from 'lucide-react'
import { jsonFetcher } from '@web/lib/swr'
import {
    useChains,
    patchChain,
    resetChain,
    useModelCatalog,
    type ChainEntryView,
    type RoutingTaskType,
    type CatalogItemView,
} from '@web/lib/intelligence-client'
import { ChainModelCard } from './model-card'
import { ModelPickerModal, type ProviderInstanceLite } from './model-picker-modal'
import type { ModelAttributesView } from '../model-attribute-badges'

interface TaskTypeChainEditorProps {
    workspaceId: string
}

interface ProvidersResponse {
    providers: Array<{
        id: string
        providerType: string
        enabled: boolean
        capabilities?: { chatModels?: string[] | null }
    }>
}

const TASK_TYPE_LABELS: Record<RoutingTaskType, { label: string; hint: string }> = {
    conversation:   { label: 'Conversation',    hint: 'Short replies, friendly chat. Wants fast + cheap.' },
    classification: { label: 'Classification',  hint: 'Yes/no + tag picks. Wants the fastest cheap model.' },
    summarization:  { label: 'Summarization',   hint: 'Compressing long text. Wants long context + cheap.' },
    codeGeneration: { label: 'Code generation', hint: 'Edit + write code. Wants strong code skills.' },
    verification:   { label: 'Verification',    hint: 'Reviewing outputs and tool results.' },
    planning:       { label: 'Planning',        hint: 'Multi-step plans. The one tier reasoning models help.' },
    logAnalysis:    { label: 'Log analysis',    hint: 'Reading logs and traces. Wants long context.' },
}

const TIER_ORDER: RoutingTaskType[] = [
    'conversation',
    'classification',
    'summarization',
    'codeGeneration',
    'verification',
    'planning',
    'logAnalysis',
]

export function TaskTypeChainEditor({ workspaceId }: TaskTypeChainEditorProps) {
    const { data: chainData, mutate, isLoading } = useChains(workspaceId)
    const { data: providersData } = useSWR<ProvidersResponse>(
        `/api/v1/workspaces/${workspaceId}/providers`,
        jsonFetcher,
    )
    // Pre-fetch the full catalog so chain rows show badges immediately.
    const { data: catalogData } = useModelCatalog({ pageSize: 200 })

    // Build a (provider+model) → attributes index from the catalog.
    const attributesIndex = useMemo(() => {
        const map = new Map<string, ModelAttributesView>()
        for (const item of (catalogData?.items ?? []) as CatalogItemView[]) {
            map.set(`${item.provider}/${item.modelId}`, {
                provider: item.provider,
                modelId: item.modelId,
                capabilities: item.capabilities,
                strengths: item.strengths,
                latencyClass: item.latencyClass,
                costClass: item.costClass,
                contextWindow: item.contextWindow,
                blendedCostPerM: item.blendedCostPerM,
                bestForHint: item.bestForHint,
            })
        }
        return map
    }, [catalogData])

    // Provider instance → providerType lookup.
    const providersById = useMemo(() => {
        const map = new Map<string, { providerType: string; enabled: boolean }>()
        for (const p of providersData?.providers ?? []) {
            map.set(p.id, { providerType: p.providerType, enabled: p.enabled })
        }
        return map
    }, [providersData])

    const providersForPicker: ProviderInstanceLite[] = useMemo(() => {
        return (providersData?.providers ?? []).map(p => ({
            id: p.id,
            providerType: p.providerType,
            enabled: p.enabled,
            chatModels: p.capabilities?.chatModels ?? [],
        }))
    }, [providersData])

    // Per-tier local edit state. Mirrors the server chain on first load
    // and on save/reset; user edits live here until "Save" is pressed.
    const [drafts, setDrafts] = useState<Record<RoutingTaskType, ChainEntryView[]>>({} as Record<RoutingTaskType, ChainEntryView[]>)
    const [open, setOpen] = useState<Record<RoutingTaskType, boolean>>({
        conversation: true,
        classification: false,
        summarization: false,
        codeGeneration: false,
        verification: false,
        planning: false,
        logAnalysis: false,
    })
    const [saving, setSaving] = useState<RoutingTaskType | null>(null)
    const [pickerFor, setPickerFor] = useState<RoutingTaskType | null>(null)

    // Sync server → local on first load + after refresh.
    useEffect(() => {
        if (!chainData) return
        const next: Record<string, ChainEntryView[]> = {}
        for (const tier of TIER_ORDER) {
            next[tier] = chainData.chains[tier] ?? []
        }
        setDrafts(next as Record<RoutingTaskType, ChainEntryView[]>)
    }, [chainData])

    function getDraft(tier: RoutingTaskType): ChainEntryView[] {
        return drafts[tier] ?? []
    }

    function updateDraft(tier: RoutingTaskType, next: ChainEntryView[]) {
        setDrafts(prev => ({ ...prev, [tier]: next }))
    }

    function move(tier: RoutingTaskType, idx: number, dir: -1 | 1) {
        const list = [...getDraft(tier)]
        const target = idx + dir
        if (target < 0 || target >= list.length) return
        const a = list[idx]!
        const b = list[target]!
        list[idx] = b
        list[target] = a
        updateDraft(tier, list.map((entry, i) => ({ ...entry, position: i })))
    }

    function remove(tier: RoutingTaskType, idx: number) {
        const list = getDraft(tier).filter((_, i) => i !== idx)
        updateDraft(tier, list.map((entry, i) => ({ ...entry, position: i })))
    }

    function addEntry(tier: RoutingTaskType, providerId: string, modelId: string) {
        const list = getDraft(tier)
        // Reject duplicates.
        if (list.some(e => e.providerId === providerId && e.modelId === modelId)) {
            toast.message('Already in chain')
            return
        }
        if (list.length >= 10) {
            toast.error('Chain limit is 10 entries')
            return
        }
        const next: ChainEntryView[] = [
            ...list,
            { id: `draft-${Date.now()}`, providerId, modelId, position: list.length },
        ]
        updateDraft(tier, next)
    }

    async function save(tier: RoutingTaskType) {
        const list = getDraft(tier)
        setSaving(tier)
        try {
            await patchChain(
                workspaceId,
                tier,
                list.map(e => ({ providerId: e.providerId, modelId: e.modelId })),
            )
            await mutate()
            toast.success(`${TASK_TYPE_LABELS[tier].label} chain saved`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(null)
        }
    }

    async function reset(tier: RoutingTaskType) {
        setSaving(tier)
        try {
            await resetChain(workspaceId, tier)
            await mutate()
            toast.success(`${TASK_TYPE_LABELS[tier].label} reset to defaults`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Reset failed')
        } finally {
            setSaving(null)
        }
    }

    if (isLoading) {
        return (
            <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                Loading routing chains…
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div>
                <h3 className="text-sm font-medium text-text-primary">Per-task chains</h3>
                <p className="text-xs text-text-muted">
                    Each task type runs through its own ordered fallback list. The router walks the chain top-down on failure.
                </p>
            </div>

            <div className="space-y-2">
                {TIER_ORDER.map(tier => {
                    const isOpen = open[tier]
                    const list = getDraft(tier)
                    const isSaving = saving === tier
                    return (
                        <div key={tier} className="rounded-sm border border-border bg-surface-1">
                            <button
                                type="button"
                                onClick={() => setOpen(o => ({ ...o, [tier]: !o[tier] }))}
                                className="flex w-full items-center justify-between p-3 text-left"
                            >
                                <div className="flex items-center gap-2">
                                    {isOpen
                                        ? <ChevronDown className="h-4 w-4 text-text-muted" />
                                        : <ChevronRight className="h-4 w-4 text-text-muted" />}
                                    <span className="text-sm font-medium text-text-primary">{TASK_TYPE_LABELS[tier].label}</span>
                                    <span className="text-[11px] text-text-muted">· {list.length} model{list.length === 1 ? '' : 's'}</span>
                                </div>
                                <span className="text-[11px] text-text-muted">{TASK_TYPE_LABELS[tier].hint}</span>
                            </button>
                            {isOpen && (
                                <div className="border-t border-border p-3 space-y-2">
                                    {list.length === 0 ? (
                                        <div className="rounded-sm border border-dashed border-border p-3 text-center text-xs text-text-muted">
                                            No models in this chain. The router will fall through to the legacy primary provider.
                                        </div>
                                    ) : (
                                        list.map((entry, idx) => {
                                            const meta = providersById.get(entry.providerId)
                                            const providerType = meta?.providerType ?? '—'
                                            const attrs = attributesIndex.get(`${providerType}/${entry.modelId}`) ?? null
                                            return (
                                                <ChainModelCard
                                                    key={`${entry.id}-${idx}`}
                                                    position={idx}
                                                    providerType={providerType}
                                                    modelId={entry.modelId}
                                                    attributes={attrs}
                                                    isFirst={idx === 0}
                                                    isLast={idx === list.length - 1}
                                                    onMoveUp={() => move(tier, idx, -1)}
                                                    onMoveDown={() => move(tier, idx, 1)}
                                                    onRemove={() => remove(tier, idx)}
                                                    disabled={isSaving}
                                                />
                                            )
                                        })
                                    )}
                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                        <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => setPickerFor(tier)}
                                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-primary hover:border-azure"
                                        >
                                            <Plus className="h-3 w-3" /> Add model
                                        </button>
                                        <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => void save(tier)}
                                            className="inline-flex items-center gap-1 rounded-md border border-azure/50 bg-surface-1 px-2 py-1 text-[11px] text-azure hover:border-azure"
                                        >
                                            {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => void reset(tier)}
                                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                                        >
                                            <RotateCcw className="h-3 w-3" /> Reset
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            <ModelPickerModal
                open={pickerFor !== null}
                onClose={() => setPickerFor(null)}
                providers={providersForPicker}
                onPick={(entry) => {
                    if (pickerFor) addEntry(pickerFor, entry.providerId, entry.modelId)
                }}
            />
        </div>
    )
}
