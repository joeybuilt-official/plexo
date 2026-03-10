// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Search, SlidersHorizontal, X, ArrowUpDown, Check, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import type { FilterDimension, ListFilterHook } from './use-list-filter'

// ── Components ────────────────────────────────────────────────────────────────

function CustomSortDropdown({
    value,
    onChange,
    options,
}: {
    value: string
    onChange: (v: string) => void
    options: { label: string; value: string }[]
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        function onClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        if (open) window.addEventListener('mousedown', onClick)
        return () => window.removeEventListener('mousedown', onClick)
    }, [open])

    const selectedLabel = options.find((o) => o.value === value)?.label ?? 'Sort'

    return (
        <div className="relative shrink-0" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={`flex justify-between items-center w-full gap-1.5 rounded-lg border px-3 py-2 min-h-[44px] md:min-h-0 text-[16px] md:text-sm transition-colors shadow-sm ${open ? 'border-zinc-500 bg-surface-2 text-text-primary' : 'border-border bg-surface-1 text-text-secondary hover:border-zinc-500 hover:text-text-secondary'
                    }`}
            >
                <div className="flex items-center gap-1.5">
                    <ArrowUpDown className="h-4 w-4 md:h-3.5 md:w-3.5" />
                    <span className="font-medium whitespace-nowrap">{selectedLabel}</span>
                </div>
                <ChevronDown className="h-4 w-4 md:hidden text-text-muted" />
            </button>

            {open && (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[170px] rounded-xl border border-border bg-canvas py-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                    <ul role="listbox" className="max-h-[300px] overflow-y-auto px-1.5 flex flex-col gap-0.5">
                        {options.map((opt) => {
                            const active = opt.value === value
                            return (
                                <li key={opt.value} role="option" aria-selected={active}>
                                    <button
                                        type="button"
                                        className={`w-full flex items-center justify-between gap-3 rounded-md px-3 py-3 md:px-2.5 md:py-1.5 text-[16px] md:text-sm transition-colors text-left ${active ? 'bg-indigo-500/15 text-indigo-300' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                                            }`}
                                        onClick={() => {
                                            onChange(opt.value)
                                            setOpen(false)
                                        }}
                                    >
                                        <span className={active ? 'font-medium' : ''}>{opt.label}</span>
                                        {active && <Check className="h-4 w-4 md:h-3 md:w-3 shrink-0" />}
                                    </button>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}
        </div>
    )
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ListToolbarProps {
    hook: ListFilterHook
    /** Placeholder text for the search input */
    placeholder?: string
    /**
     * Filter dimensions to display in the collapsible panel.
     * Pages are responsible for computing options (and their dimmed state)
     * from the currently loaded data, then passing them here.
     * Omit or pass an empty array for search-only toolbars.
     */
    dimensions?: FilterDimension[]
    /** Options for rendering a sort dropdown */
    sortOptions?: { label: string; value: string }[]
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ListToolbar({
    hook,
    placeholder = 'Search…',
    dimensions = [],
    sortOptions = [],
}: ListToolbarProps) {
    const {
        search,
        setSearch,
        showFilters,
        toggleFilters,
        filterValues,
        setFilter,
        hasFilters,
        activeFilterCount,
        sort,
        setSort,
        clearAll,
    } = hook

    const hasDimensions = dimensions.length > 0
    // Only dims that currently have a non-null value (for pills)
    const activeDims = dimensions.filter((d) => filterValues[d.key] !== null)

    return (
        <div className="flex flex-col gap-3">
            {/* ── Toolbar row ──────────────────────────────────────────────── */}
            <div className="flex flex-col md:flex-row gap-2">
                {/* Search input */}
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 md:h-3.5 md:w-3.5 -translate-y-1/2 text-text-muted pointer-events-none" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={placeholder}
                        className="w-full rounded-lg border border-border bg-surface-1/60 py-2 pl-10 pr-4 min-h-[44px] md:min-h-[32px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo/20 transition-colors"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch('')}
                            className="absolute right-0 top-0 bottom-0 px-3 text-text-muted hover:text-text-secondary transition-colors flex justify-center items-center"
                            aria-label="Clear search"
                        >
                            <X className="h-4 w-4 md:h-3 md:w-3" />
                        </button>
                    )}
                </div>

                {/* Filters toggle — only rendered when dimensions exist */}
                {hasDimensions && (
                    <button
                        onClick={toggleFilters}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${showFilters
                            ? 'border-indigo-600 bg-indigo/10 text-indigo'
                            : 'border-border text-text-secondary hover:border-zinc-600 hover:text-text-primary'
                            }`}
                        aria-expanded={showFilters}
                    >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        Filters
                        {activeFilterCount > 0 && (
                            <span className="ml-0.5 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[9px] font-semibold text-text-primary leading-none">
                                {activeFilterCount}
                            </span>
                        )}
                    </button>
                )}

                {/* Sort dropdown */}
                {sortOptions.length > 0 && (
                    <CustomSortDropdown value={sort} onChange={setSort} options={sortOptions} />
                )}

                {/* Clear button */}
                {hasFilters && (
                    <button
                        onClick={clearAll}
                        className="flex items-center justify-center gap-1 rounded-lg border border-border px-2.5 py-2 min-h-[44px] md:min-h-0 text-[16px] md:text-sm text-text-muted hover:border-zinc-600 hover:text-text-secondary transition-colors"
                    >
                        <X className="h-4 w-4 md:h-3 md:w-3" />
                        Clear
                    </button>
                )}
            </div>

            {/* ── Expandable filter panel ──────────────────────────────────── */}
            {showFilters && hasDimensions && (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-1/40 p-3.5">
                    {dimensions.map((dim) => {
                        const current = filterValues[dim.key] ?? null
                        return (
                            <div key={dim.key} className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] uppercase tracking-wide text-text-muted w-16 shrink-0">
                                    {dim.label}
                                </span>
                                <div className="flex gap-1.5 flex-wrap">
                                    {/* "All" chip — always present */}
                                    <button
                                        onClick={() => setFilter(dim.key, null)}
                                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${current === null
                                            ? 'bg-indigo text-text-primary'
                                            : 'border border-border text-text-secondary hover:border-zinc-600 hover:text-text-primary'
                                            }`}
                                    >
                                        All
                                    </button>

                                    {/* Option chips */}
                                    {dim.options.map((opt) => (
                                        <button
                                            key={opt.value}
                                            onClick={() => {
                                                if (!opt.dimmed)
                                                    setFilter(
                                                        dim.key,
                                                        current === opt.value ? null : opt.value,
                                                    )
                                            }}
                                            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${current === opt.value
                                                ? 'bg-indigo text-text-primary'
                                                : opt.dimmed
                                                    ? 'border border-border text-text-muted opacity-40 cursor-default'
                                                    : 'border border-border text-text-secondary hover:border-zinc-600 hover:text-text-primary'
                                                }`}
                                            aria-pressed={current === opt.value}
                                            aria-disabled={opt.dimmed}
                                        >
                                            {opt.icon != null && (
                                                <span className="shrink-0">{opt.icon}</span>
                                            )}
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* ── Active filter pills (panel collapsed) ───────────────────── */}
            {!showFilters && activeDims.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                    {activeDims.map((dim) => {
                        const val = filterValues[dim.key]!
                        const label = dim.options.find((o) => o.value === val)?.label ?? val
                        return (
                            <span
                                key={dim.key}
                                className="flex items-center gap-1 rounded-full border border-indigo-800/50 bg-indigo-900/20 pl-3 pr-1 py-1 text-[13px] md:py-0.5 md:pl-2.5 md:pr-0.5 md:text-[11px] text-indigo"
                            >
                                {dim.label}: {label}
                                <button
                                    onClick={() => setFilter(dim.key, null)}
                                    className="hover:text-indigo-200 ml-0.5 h-6 w-6 md:h-4 md:w-4 flex items-center justify-center shrink-0"
                                    aria-label={`Remove ${dim.label} filter`}
                                >
                                    <X className="h-3.5 w-3.5 md:h-2.5 md:w-2.5" />
                                </button>
                            </span>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
