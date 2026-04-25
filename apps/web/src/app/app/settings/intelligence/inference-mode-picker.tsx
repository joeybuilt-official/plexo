// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * InferenceModePicker — Phase 2a routing UI.
 *
 * Renders the four inference modes (auto / byok / proxy / override)
 * as a single-select pill row, persists the choice via patchInferenceMode,
 * and reads the current value from useIntelligenceSettings.
 *
 * Mode descriptions are inline (one sentence each) so users don't need
 * to dig into docs to know what they're picking. The active mode gets
 * a thicker border + the project's azure accent ring.
 *
 * ── Two routing experiences, only one is shippable right now ────────
 * Mode 1 (auto / byok / override) — BYOK: user adds their own provider
 * keys, Plexo's intelligent router picks between them by task type,
 * cost, latency. LIVE.
 *
 * Mode 2 (proxy) — Plexo-managed subscription: user pays a monthly
 * fee, Plexo routes everything on its own upstream keys with a quota.
 * COMING SOON — marked disabled + coming-soon badge in the UI below.
 * The executor's handleProxy path in
 * packages/agent/src/providers/router.ts:handleProxy still works for
 * any workspace that has `inferenceMode: 'proxy'` set manually (direct
 * DB edit or testing), so no one gets orphaned. We just don't let new
 * workspaces pick it from the UI until the subscription/billing infra
 * ships.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Sparkles, KeyRound, Cloud, Settings2, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
    useIntelligenceSettings,
    patchInferenceMode,
    type InferenceMode,
} from '@web/lib/intelligence-client'

interface ModeOption {
    value: InferenceMode
    label: string
    icon: LucideIcon
    summary: string
    /**
     * When true, the mode is presented as a coming-soon feature:
     * visually distinct, non-selectable, with a "Coming soon" badge.
     * Used for Plexo Proxy until the managed subscription product ships.
     */
    comingSoon?: boolean
}

const MODE_OPTIONS: ModeOption[] = [
    {
        value: 'auto',
        label: 'Auto',
        icon: Sparkles,
        summary: 'Plexo picks the cheapest model that meets the task’s strength requirement.',
    },
    {
        value: 'byok',
        label: 'BYOK',
        icon: KeyRound,
        summary: 'Use your own keys + the chain you configured below. No automatic substitution.',
    },
    {
        value: 'proxy',
        label: 'Plexo Proxy',
        icon: Cloud,
        summary: 'Pay a monthly fee and let Plexo handle everything — no API keys, no configuration, metered by quota.',
        comingSoon: true,
    },
    {
        value: 'override',
        label: 'Override',
        icon: Settings2,
        summary: 'Pin one model for every task type. Use only when debugging or benchmarking.',
    },
]

export function InferenceModePicker({ workspaceId }: { workspaceId: string }) {
    const { data, mutate, isLoading } = useIntelligenceSettings(workspaceId)
    const [pending, setPending] = useState<InferenceMode | null>(null)

    const current = data?.settings.inferenceMode ?? 'auto'

    async function handlePick(mode: InferenceMode) {
        if (mode === current || pending) return
        // Plexo Proxy is a future managed-subscription product; don't let
        // new workspaces opt in from the UI until the billing infra ships.
        // The executor's handleProxy path still honors existing workspaces
        // that have `proxy` set via direct DB edit.
        const opt = MODE_OPTIONS.find(o => o.value === mode)
        if (opt?.comingSoon) return
        setPending(mode)
        try {
            await patchInferenceMode(workspaceId, mode)
            await mutate()
            toast.success(`Inference mode set to ${mode}`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update inference mode')
        } finally {
            setPending(null)
        }
    }

    return (
        <div className="space-y-3">
            <div>
                <h3 className="text-sm font-medium text-text-primary">Inference mode</h3>
                <p className="text-xs text-text-muted">
                    Controls how Plexo decides which model to use when a task starts.
                </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
                {MODE_OPTIONS.map(opt => {
                    const Icon = opt.icon
                    const active = current === opt.value
                    const busy = pending === opt.value
                    const isComingSoon = opt.comingSoon === true
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            disabled={isLoading || pending !== null || isComingSoon}
                            onClick={() => void handlePick(opt.value)}
                            aria-pressed={active}
                            aria-disabled={isComingSoon || undefined}
                            title={isComingSoon ? 'Coming soon — managed Plexo subscription is not yet available' : undefined}
                            className={`flex items-start gap-3 rounded-sm border p-3 text-left transition-colors ${
                                active
                                    ? 'border-azure bg-surface-1 ring-1 ring-azure/40'
                                    : isComingSoon
                                        ? 'border-dashed border-border/60 bg-surface-1/50 cursor-not-allowed'
                                        : 'border-border bg-surface-1 hover:border-muted'
                            } ${isComingSoon ? 'opacity-70' : 'disabled:opacity-50'}`}
                        >
                            <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                                active ? 'text-azure' : isComingSoon ? 'text-text-muted/60' : 'text-text-muted'
                            }`} />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-sm font-medium ${isComingSoon ? 'text-text-primary/70' : 'text-text-primary'}`}>
                                        {opt.label}
                                    </span>
                                    {isComingSoon && (
                                        <span className="rounded-sm border border-amber-700/40 bg-amber-950/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300">
                                            Coming soon
                                        </span>
                                    )}
                                    {busy && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
                                </div>
                                <p className="mt-0.5 text-[11px] text-text-muted leading-snug">{opt.summary}</p>
                            </div>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
