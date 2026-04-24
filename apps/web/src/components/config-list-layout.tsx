// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ConfigListLayout — unified two-column layout for configuration pages.
 *
 * Used by Integrations, AI Models, and Channels pages so they share a single
 * visual pattern: page header + optional slot + search toolbar + list/detail.
 *
 * The component is "dumb": it renders a layout and delegates all list-item,
 * detail-pane, and action rendering to slots. Selection state lives in the
 * parent so pages keep their own fetching, filtering, and CRUD logic.
 */

'use client'

import type { ReactNode } from 'react'
import { ListToolbar } from '@web/components/list-toolbar'
import type { ListFilterHook, FilterDimension } from '@web/components/list-toolbar'

export interface ConfigListLayoutProps<T> {
    // Header
    title: string
    subtitle?: ReactNode
    headerActions?: ReactNode

    // Optional content rendered between header and toolbar (e.g. AI chain pills)
    preToolbarSlot?: ReactNode

    // Optional content rendered between header and everything else, before preToolbarSlot
    bannerSlot?: ReactNode

    // Toolbar (pass-through to ListToolbar). All optional — when
    // `filterHook` is undefined the toolbar is skipped entirely so pages
    // that don't want a filter/search/sort can reuse the same chrome.
    filterHook?: ListFilterHook
    searchPlaceholder?: string
    filterDimensions?: FilterDimension[]
    sortOptions?: { label: string; value: string }[]

    // List
    items: T[]
    loading?: boolean
    emptyMessage?: string
    getItemKey: (item: T) => string
    isSelected: (item: T) => boolean
    onSelect: (item: T) => void
    renderListItem: (item: T, opts: { selected: boolean }) => ReactNode
    listWidthClass?: string  // default "md:w-[300px]"

    // Detail pane
    detail: ReactNode
    emptyDetail?: ReactNode

    // Error banner (shown above toolbar)
    errorBanner?: ReactNode

    // Footer (e.g. env warnings)
    footer?: ReactNode
}

export function ConfigListLayout<T>({
    title,
    subtitle,
    headerActions,
    preToolbarSlot,
    bannerSlot,
    filterHook,
    searchPlaceholder,
    filterDimensions,
    sortOptions,
    items,
    loading,
    emptyMessage = 'No items match your filters',
    getItemKey,
    isSelected,
    onSelect,
    renderListItem,
    listWidthClass = 'md:w-[300px]',
    detail,
    emptyDetail,
    errorBanner,
    footer,
}: ConfigListLayoutProps<T>) {
    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-text-primary">{title}</h1>
                    {subtitle && (
                        <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>
                    )}
                </div>
                {headerActions && (
                    <div className="shrink-0 flex items-center gap-2">{headerActions}</div>
                )}
            </div>

            {/* Banner (status, nudge, etc.) */}
            {bannerSlot}

            {/* Pre-toolbar slot (e.g. AI chain pills) */}
            {preToolbarSlot}

            {/* Error banner */}
            {errorBanner}

            {/* Toolbar — skipped entirely when no filterHook is passed */}
            {filterHook && (
                <ListToolbar
                    hook={filterHook}
                    placeholder={searchPlaceholder}
                    dimensions={filterDimensions ?? []}
                    sortOptions={sortOptions ?? []}
                />
            )}

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pt-2 pb-4 md:pb-0">
                {/* Left panel — list */}
                <div
                    className={`w-full ${listWidthClass} shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-y-auto pb-2 md:pb-0 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]`}
                >
                    <div className="flex-1 flex flex-row md:flex-col gap-2 md:gap-1">
                        {loading ? (
                            <div className="flex items-center justify-center py-8 min-w-[200px] shrink-0 snap-start">
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-azure" />
                            </div>
                        ) : items.length === 0 ? (
                            <div className="text-center py-6 min-w-[200px] shrink-0 snap-start">
                                <p className="text-xs text-text-muted">{emptyMessage}</p>
                            </div>
                        ) : (
                            items.map((item) => {
                                const selected = isSelected(item)
                                return (
                                    <button
                                        key={getItemKey(item)}
                                        onClick={() => onSelect(item)}
                                        className={`text-left rounded-xl border px-3 py-2.5 transition-all text-sm shrink-0 snap-start min-w-[250px] md:min-w-0 md:w-full min-h-[44px] ${
                                            selected
                                                ? 'border-azure/50 bg-surface-1 shadow-sm shadow-azure/10'
                                                : 'border-border/60 bg-surface-1/30 hover:border-border hover:bg-surface-1/60'
                                        }`}
                                    >
                                        {renderListItem(item, { selected })}
                                    </button>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* Right panel — detail */}
                <div className="flex-1 rounded-xl border border-border bg-surface-1/40 flex flex-col overflow-hidden max-w-[100vw] sm:max-w-none">
                    {detail ?? emptyDetail ?? (
                        <div className="flex-1 flex items-center justify-center">
                            <p className="text-sm text-text-muted">Select an item</p>
                        </div>
                    )}
                </div>
            </div>

            {footer}
        </div>
    )
}
