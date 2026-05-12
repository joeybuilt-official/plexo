// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilterOption {
    value: string
    label: string
    /** Optional icon rendered before the label in filter chips */
    icon?: ReactNode
    /**
     * When true the chip is rendered at reduced opacity and is non-interactive.
     * Use this to reflect options that have no matching data in the current set.
     */
    dimmed?: boolean
}

export interface FilterDimension {
    key: string
    /** Short label shown in the filter panel row and in active-filter pills */
    label: string
    options: FilterOption[]
}

export interface ListFilterHook {
    // ── Search ──────────────────────────────────────────────────────────────
    search: string
    setSearch: (v: string) => void
    // ── Filter panel visibility ──────────────────────────────────────────────
    showFilters: boolean
    toggleFilters: () => void
    // ── Per-dimension selected values (null = no filter / "All") ────────────
    filterValues: Record<string, string | null>
    setFilter: (key: string, value: string | null) => void
    // ── Derived ─────────────────────────────────────────────────────────────
    hasFilters: boolean
    /** Count of dimension filters that are non-null (excludes text search) */
    activeFilterCount: number
    // ── Sort ────────────────────────────────────────────────────────────────
    sort: string
    setSort: (v: string) => void
    clearAll: () => void
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Manages search + multi-dimension filter state for a list page.
 * Synchronizes state with URL search parameters.
 *
 * @param keys - The filter dimension keys to initialise (order doesn't matter).
 *               Pass a module-level constant array so the initialiser runs once.
 */
export function useListFilter(keys: readonly string[], initialSort: string = ''): ListFilterHook {
    const router = useRouter()
    const pathname = usePathname()

    // Initialize from empty — will hydrate from URL on first client render
    const [search, setSearch] = useState('')
    const [sort, setSort] = useState(initialSort)
    const [showFilters, setShowFilters] = useState(false)
    const [filterValues, setFilterValues] = useState<Record<string, string | null>>(
        () => Object.fromEntries(keys.map((k) => [k, null]))
    )
    const [hydrated, setHydrated] = useState(false)

    // Hydrate from URL query string on mount (client-only, avoids useSearchParams)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        setSearch(params.get('q') ?? '')
        const s = params.get('sort')
        if (s) setSort(s)
        setFilterValues(Object.fromEntries(keys.map((k) => [k, params.get(k) ?? null])))
        setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const setFilter = useCallback((key: string, value: string | null) => {
        setFilterValues((prev) => ({ ...prev, [key]: value }))
    }, [])

    const toggleFilters = useCallback(() => setShowFilters((v) => !v), [])

    const clearAll = useCallback(() => {
        setSearch('')
        setFilterValues((prev) =>
            Object.fromEntries(Object.keys(prev).map((k) => [k, null]))
        )
        setSort(initialSort)
    }, [initialSort])

    const activeFilterCount = useMemo(
        () => Object.values(filterValues).filter((v) => v !== null).length,
        [filterValues]
    )

    const hasFilters = search !== '' || activeFilterCount > 0

    // Sync state to URL (debounced, after hydration)
    useEffect(() => {
        if (!hydrated) return
        const timer = setTimeout(() => {
            const params = new URLSearchParams(window.location.search)

            if (search) params.set('q', search)
            else params.delete('q')

            if (sort && sort !== initialSort) params.set('sort', sort)
            else params.delete('sort')

            Object.entries(filterValues).forEach(([k, v]) => {
                if (v) params.set(k, v)
                else params.delete(k)
            })

            const newQuery = params.toString()
            const currentQuery = new URLSearchParams(window.location.search).toString()

            if (currentQuery !== newQuery) {
                router.replace(`${pathname}${newQuery ? `?${newQuery}` : ''}`, { scroll: false })
            }
        }, 250)

        return () => clearTimeout(timer)
    }, [search, sort, filterValues, pathname, router, initialSort, hydrated])

    return {
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
    }
}
