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
import { ChevronLeft } from 'lucide-react'

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
    // On mobile, detect whether an item is selected to show detail panel
    const hasSelection = items.some((item) => isSelected(item))

    function handleSelect(item: T) {
        onSelect(item)
    }

    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header — on mobile detail view, show a back button instead */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                <div className="flex items-center gap-2 min-w-0">
                    {/* Back button: mobile only, shown when detail is open */}
                    {hasSelection && (
                        <button
                            className="md:hidden flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors shrink-0 -ml-1 pr-1"
                            onClick={() => {
                                // Deselect by selecting a non-existent item — pages must
                                // handle selection as toggle (second click deselects).
                                // We find the currently-selected item and call onSelect to
                                // toggle it off, which is the standard pattern used across pages.
                                const selected = items.find((item) => isSelected(item))
                                if (selected) onSelect(selected)
                            }}
                            aria-label="Back to list"
                        >
                            <ChevronLeft className="h-5 w-5 shrink-0" />
                            <span>Back</span>
                        </button>
                    )}
                    <div className="min-w-0">
                        <h1 className="text-2xl font-semibold text-text-primary">{title}</h1>
                        {subtitle && (
                            <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>
                        )}
                    </div>
                </div>
                {headerActions && (
                    <div className="shrink-0 flex items-center flex-wrap gap-2">{headerActions}</div>
                )}
            </div>

            {/* Banner (status, nudge, etc.) */}
            {bannerSlot}

            {/* Pre-toolbar slot (e.g. AI chain pills) */}
            {preToolbarSlot}

            {/* Error banner */}
            {errorBanner}

            {/* Toolbar — skipped entirely when no filterHook is passed.
                On mobile, hide toolbar when detail is open to save space. */}
            {filterHook && !hasSelection && (
                <ListToolbar
                    hook={filterHook}
                    placeholder={searchPlaceholder}
                    dimensions={filterDimensions ?? []}
                    sortOptions={sortOptions ?? []}
                />
            )}
            {filterHook && hasSelection && (
                <div className="hidden md:block">
                    <ListToolbar
                        hook={filterHook}
                        placeholder={searchPlaceholder}
                        dimensions={filterDimensions ?? []}
                        sortOptions={sortOptions ?? []}
                    />
                </div>
            )}

            {/* Two-panel layout
                Mobile: show list OR detail (not both, not scroll).
                md+:    show both side-by-side. */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pt-2 pb-4 md:pb-0">
                {/* Left panel — list. Hidden on mobile when detail is open. */}
                <div
                    className={`w-full ${listWidthClass} shrink-0 flex flex-col gap-1 overflow-y-auto ${hasSelection ? 'hidden md:flex' : 'flex'}`}
                >
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-azure" />
                        </div>
                    ) : items.length === 0 ? (
                        <div className="text-center py-6">
                            <p className="text-xs text-text-muted">{emptyMessage}</p>
                        </div>
                    ) : (
                        items.map((item) => {
                            const selected = isSelected(item)
                            return (
                                <button
                                    key={getItemKey(item)}
                                    onClick={() => handleSelect(item)}
                                    className={`text-left rounded border px-3 py-2.5 transition-all text-sm w-full min-h-[44px] ${
                                        selected
                                            ? 'border-accent-dim bg-surface-1'
                                            : 'border-border bg-surface-1 hover:border-accent-dim'
                                    }`}
                                >
                                    {renderListItem(item, { selected })}
                                </button>
                            )
                        })
                    )}
                </div>

                {/* Right panel — detail. Hidden on mobile when no selection. */}
                <div className={`flex-1 rounded border border-border bg-surface-1 flex flex-col overflow-hidden ${hasSelection ? 'flex' : 'hidden md:flex'}`}>
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
