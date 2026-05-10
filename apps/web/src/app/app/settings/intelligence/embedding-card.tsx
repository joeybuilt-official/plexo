// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * EmbeddingCard — single per-provider card for the Embeddings section.
 *
 * Mirrors the visual rhythm of provider-chain.tsx but adds:
 *   - Embedding-model dropdown (filtered to embedding-capable models)
 *   - Dimension count
 *   - Last-used timestamp
 *   - Health pill
 *
 * Selection mutation goes through `patchEmbeddingModel` from
 * apps/web/src/lib/embeddings-client.ts; the parent decides whether the
 * resulting `dimensionChanged` flag triggers the re-embed modal.
 */

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { EmbeddingProviderRow } from '@web/lib/embeddings-client'

interface EmbeddingCardProps {
    row: EmbeddingProviderRow
    /** Models the user can pick from. Caller passes the curated list per provider. */
    availableModels: string[]
    onModelChange: (model: string) => Promise<void>
}

function healthPillClass(h: EmbeddingProviderRow['health']): string {
    if (h === 'healthy') return 'bg-emerald-400'
    if (h === 'degraded') return 'bg-amber-400'
    if (h === 'broken') return 'bg-red-500'
    return 'bg-muted'
}

function relativeTime(iso: string | null): string {
    if (!iso) return 'never'
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
}

export function EmbeddingCard({ row, availableModels, onModelChange }: EmbeddingCardProps) {
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const next = e.target.value
        setSaving(true)
        setError(null)
        try {
            await onModelChange(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update')
        } finally {
            setSaving(false)
        }
    }

    const merged = Array.from(new Set([
        ...(row.selectedModel ? [row.selectedModel] : []),
        ...availableModels,
    ]))

    return (
        <div className="rounded-sm border border-border bg-surface-1 p-3 flex flex-col gap-2 min-w-[180px]">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary truncate">{row.nickname}</span>
                <span
                    className={`inline-block h-2 w-2 rounded-full ${healthPillClass(row.health)}`}
                    aria-label={`health: ${row.health}`}
                />
            </div>
            <div className="text-[11px] uppercase tracking-wide text-text-muted">
                {row.providerType}
            </div>

            <select
                value={row.selectedModel ?? ''}
                onChange={handleChange}
                disabled={saving || merged.length === 0}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary focus:border-azure focus-ring disabled:opacity-50"
            >
                {merged.length === 0 && <option value="">No embedding models</option>}
                {merged.map(m => (
                    <option key={m} value={m}>{m}</option>
                ))}
            </select>

            <div className="flex items-center justify-between text-[11px] text-text-muted">
                <span>{row.dimensions ? `${row.dimensions} dim` : '— dim'}</span>
                <span>last used {relativeTime(row.lastUsedAt)}</span>
            </div>

            {saving && (
                <div className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                </div>
            )}
            {error && <div role="alert" className="text-[11px] text-red-400">{error}</div>}
        </div>
    )
}
