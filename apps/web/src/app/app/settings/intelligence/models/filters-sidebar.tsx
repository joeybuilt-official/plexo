// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * FiltersSidebar — Phase 2b catalog browser left rail.
 *
 * Plain controlled selects + text input. Parent owns state and re-fetches
 * the catalog whenever any field changes. Mirrors the inline filters in
 * the chain editor's picker modal so a user only learns one set of
 * controls across both surfaces.
 */

import { Search } from 'lucide-react'

export interface CatalogFilters {
    provider: string
    capability: string
    strength: string
    cost: string
    latency: string
    q: string
    sort: 'score' | 'cost' | 'context' | 'name'
}

interface FiltersSidebarProps {
    filters: CatalogFilters
    onChange: (next: CatalogFilters) => void
}

const PROVIDERS = ['', 'anthropic', 'openai', 'google', 'mistral', 'groq', 'deepseek', 'together', 'fireworks', 'cerebras', 'cohere', 'openrouter', 'xai']
const CAPABILITIES = [
    { value: '', label: 'Any capability' },
    { value: 'tools', label: 'Tools' },
    { value: 'vision', label: 'Vision' },
    { value: 'json_mode', label: 'JSON mode' },
    { value: 'long_context', label: 'Long context' },
]
const STRENGTHS = [
    { value: '', label: 'Any strength' },
    { value: 'reasoning', label: 'Reasoning' },
    { value: 'speed', label: 'Speed' },
    { value: 'cheap', label: 'Cheap' },
    { value: 'code', label: 'Code' },
    { value: 'multilingual', label: 'Multilingual' },
    { value: 'creative', label: 'Creative' },
]

export function FiltersSidebar({ filters, onChange }: FiltersSidebarProps) {
    function set<K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]) {
        onChange({ ...filters, [key]: value })
    }

    return (
        <div className="space-y-4">
            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Search</label>
                <div className="relative mt-1">
                    <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
                    <input
                        type="text"
                        value={filters.q}
                        onChange={e => set('q', e.target.value)}
                        placeholder="Model id…"
                        className="w-full rounded-md border border-border bg-surface-1 px-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus-ring focus:ring-1 focus:ring-azure"
                    />
                </div>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Provider</label>
                <select
                    value={filters.provider}
                    onChange={e => set('provider', e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    {PROVIDERS.map(p => (
                        <option key={p || 'any'} value={p}>{p || 'All providers'}</option>
                    ))}
                </select>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Capability</label>
                <select
                    value={filters.capability}
                    onChange={e => set('capability', e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    {CAPABILITIES.map(o => (
                        <option key={o.value || 'any'} value={o.value}>{o.label}</option>
                    ))}
                </select>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Strength</label>
                <select
                    value={filters.strength}
                    onChange={e => set('strength', e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    {STRENGTHS.map(o => (
                        <option key={o.value || 'any'} value={o.value}>{o.label}</option>
                    ))}
                </select>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Cost class</label>
                <select
                    value={filters.cost}
                    onChange={e => set('cost', e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    <option value="">Any cost</option>
                    <option value="free">Free</option>
                    <option value="cheap">Cheap</option>
                    <option value="standard">Standard</option>
                    <option value="premium">Premium</option>
                </select>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Latency class</label>
                <select
                    value={filters.latency}
                    onChange={e => set('latency', e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    <option value="">Any speed</option>
                    <option value="fast">Fast</option>
                    <option value="medium">Medium</option>
                    <option value="slow">Slow</option>
                </select>
            </div>

            <div>
                <label className="text-[11px] uppercase tracking-wide text-text-muted">Sort</label>
                <select
                    value={filters.sort}
                    onChange={e => set('sort', e.target.value as CatalogFilters['sort'])}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
                >
                    <option value="score">Score</option>
                    <option value="cost">Cost (cheap → expensive)</option>
                    <option value="context">Context window</option>
                    <option value="name">Name</option>
                </select>
            </div>
        </div>
    )
}
