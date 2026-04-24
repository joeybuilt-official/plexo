// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import {
    DndContext,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
    type DragStartEvent,
    DragOverlay,
} from '@dnd-kit/core'
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    rectSortingStrategy,
    arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Loader2, RefreshCw, Plus, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export type ChainHealth = 'healthy' | 'degraded' | 'broken'

export interface ChainCardData {
    id: string
    providerType: string
    nickname: string
    model: string
    icon: LucideIcon
    free: boolean
    health: ChainHealth
}

interface ProviderChainProps {
    cards: ChainCardData[]
    activeProviderId: string | null
    /** Provider type whose detail pane is currently open — drives card selection ring. */
    selectedProviderType?: string | null
    onReorder: (orderedIds: string[]) => void
    /** Fired when the user clicks a chain card — opens that provider in the detail pane. */
    onCardClick: (providerType: string) => void
    onAdd: () => void
    onTest: () => void
    testing: boolean
    bannerLabel: string
    bannerOk: boolean
    testResult?: { message: string; ok: boolean } | null
}

// ── Card component ───────────────────────────────────────────────────────────

function healthDotClass(h: ChainHealth): string {
    if (h === 'healthy') return 'bg-emerald-400'
    if (h === 'degraded') return 'bg-amber-400'
    return 'bg-red-500'
}

function SortableProviderCard({
    card,
    position,
    isActive,
    isSelected,
    onCardClick,
}: {
    card: ChainCardData
    position: number
    /** Runtime-active provider (what Plexo is serving) — drives the "Active" badge. */
    isActive: boolean
    /** Whether this card's provider is currently shown in the detail pane. */
    isSelected: boolean
    onCardClick: (providerType: string) => void
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: card.id })

    const [pulse, setPulse] = useState(false)

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
    }

    const Icon = card.icon

    function triggerSelect() {
        setPulse(true)
        window.setTimeout(() => setPulse(false), 450)
        onCardClick(card.providerType)
    }

    function handleClick(e: React.MouseEvent<HTMLDivElement>) {
        // Ignore clicks that originated inside the drag handle button
        const target = e.target as HTMLElement
        if (target.closest('[data-drag-handle="true"]')) return
        triggerSelect()
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        // Enter selects; Space is reserved for dnd-kit's KeyboardSensor (lift/drop).
        if (e.key === 'Enter') {
            e.preventDefault()
            triggerSelect()
        }
    }

    // Merge our Enter-to-select handler with dnd-kit's Space-to-lift handler
    // so spreading {...listeners} doesn't clobber our handler.
    const mergedKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        handleKeyDown(e)
        const dndKeyDown = (listeners as { onKeyDown?: (e: React.KeyboardEvent) => void } | undefined)?.onKeyDown
        if (dndKeyDown) dndKeyDown(e)
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            role="button"
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={mergedKeyDown}
            className={`
                group relative flex flex-col items-stretch
                rounded-xl border transition-[border-color,background-color,opacity,box-shadow] duration-200
                w-[148px] shrink-0 cursor-pointer select-none
                focus:outline-none focus-visible:ring-2 focus-visible:ring-azure
                ${isDragging ? 'opacity-40 z-50' : 'opacity-100'}
                ${pulse ? 'ring-2 ring-azure' : ''}
                ${isSelected
                    ? 'border-azure ring-1 ring-azure/60 bg-azure-dim'
                    : isActive
                        ? 'border-azure/70 bg-azure-dim shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
                        : 'border-border/60 bg-surface-1/60 hover:border-border hover:bg-surface-1/80'}
            `}
            aria-label={`${card.nickname}, priority ${position}${isActive ? ', currently active' : ''}. Press Enter to open details.`}
            aria-pressed={isSelected}
        >
            {/* Drag handle — absolute top-left. Visual affordance only: pointer drag
                works from anywhere on the card (dnd-kit listeners are on the outer
                element), and keyboard drag is triggered by focusing the card and
                pressing Space (handled by dnd-kit's KeyboardSensor via `attributes`). */}
            <span
                data-drag-handle="true"
                className="
                    absolute top-1.5 left-1.5 z-10 flex items-center justify-center
                    h-7 w-7 rounded-md text-text-muted/70
                    group-hover:text-text-primary
                    cursor-grab active:cursor-grabbing
                    touch-none pointer-events-none
                "
                aria-hidden="true"
            >
                <GripVertical className="h-4 w-4" />
            </span>

            {/* Priority number — absolute top-right */}
            <span
                className={`
                    absolute top-1.5 right-2 text-[11px] font-bold tabular-nums
                    ${isActive ? 'text-azure' : 'text-text-muted/70'}
                `}
                aria-hidden="true"
            >
                {position}
            </span>

            {/* Card body — visual only; click/keyboard handled on outer element */}
            <div className="flex flex-col items-center gap-1.5 px-3 pt-8 pb-2.5 text-center pointer-events-none">
                <div className="flex items-center gap-1.5">
                    <Icon className="h-4 w-4 text-text-secondary" />
                    <span className="text-[13px] font-medium text-text-primary truncate max-w-[90px]">
                        {card.nickname}
                    </span>
                </div>
                <span
                    className="text-[10px] font-mono text-text-muted truncate max-w-[124px]"
                    title={card.model}
                >
                    {card.model}
                </span>

                <div className="flex items-center gap-1 mt-0.5">
                    <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${healthDotClass(card.health)}`}
                        aria-label={`Health: ${card.health}`}
                    />
                    {card.free && (
                        <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                            FREE
                        </span>
                    )}
                </div>
            </div>

            {isActive && (
                <span
                    className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-azure px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm whitespace-nowrap pointer-events-none"
                    aria-hidden="true"
                >
                    Active
                </span>
            )}
        </div>
    )
}

// Lightweight non-interactive copy for the DragOverlay
function ProviderCardOverlay({ card, position }: { card: ChainCardData; position: number }) {
    const Icon = card.icon
    return (
        <div
            className="
                relative flex flex-col items-center gap-1.5
                rounded-xl border border-azure/60 bg-surface-2/95
                px-3 pt-8 pb-2.5 w-[148px]
                shadow-2xl scale-105 cursor-grabbing
            "
        >
            <GripVertical className="absolute top-1.5 left-1.5 h-4 w-4 text-text-primary" />
            <span className="absolute top-1.5 right-2 text-[11px] font-bold tabular-nums text-azure">
                {position}
            </span>
            <div className="flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-text-secondary" />
                <span className="text-[13px] font-medium text-text-primary truncate max-w-[90px]">
                    {card.nickname}
                </span>
            </div>
            <span className="text-[10px] font-mono text-text-muted truncate max-w-[124px]">
                {card.model}
            </span>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${healthDotClass(card.health)}`} />
        </div>
    )
}

// ── Main chain ───────────────────────────────────────────────────────────────

export function ProviderChain({
    cards,
    activeProviderId,
    selectedProviderType = null,
    onReorder,
    onCardClick,
    onAdd,
    onTest,
    testing,
    bannerLabel,
    bannerOk,
    testResult,
}: ProviderChainProps) {
    const [activeDragId, setActiveDragId] = useState<string | null>(null)

    const sensors = useSensors(
        useSensor(PointerSensor, {
            // 8px movement before drag starts — click vs drag disambiguation
            activationConstraint: { distance: 8 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    )

    function handleDragStart(event: DragStartEvent) {
        setActiveDragId(String(event.active.id))
    }

    function handleDragEnd(event: DragEndEvent) {
        setActiveDragId(null)
        const { active, over } = event
        if (!over || active.id === over.id) return
        const oldIndex = cards.findIndex(c => c.id === active.id)
        const newIndex = cards.findIndex(c => c.id === over.id)
        if (oldIndex < 0 || newIndex < 0) return
        const nextOrder = arrayMove(cards, oldIndex, newIndex).map(c => c.id)
        onReorder(nextOrder)
    }

    const draggingCard = activeDragId ? cards.find(c => c.id === activeDragId) : null
    const draggingPosition = draggingCard ? cards.findIndex(c => c.id === draggingCard.id) + 1 : 0

    const statusDotColor = bannerOk ? 'bg-emerald-400' : 'bg-amber-400'

    // ── Empty state ──────────────────────────────────────────────────────────
    if (cards.length === 0) {
        return (
            <div className="rounded-xl border border-border/60 bg-surface-1/40 px-4 py-3 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${statusDotColor}`} />
                    <span className="text-sm text-text-primary flex-1 min-w-0 truncate">{bannerLabel}</span>
                </div>
                <button
                    onClick={onAdd}
                    className="
                        flex items-center justify-center gap-2
                        rounded-xl border border-dashed border-border/80
                        bg-surface-1/40 hover:bg-surface-2/40 hover:border-azure/60
                        py-6 text-sm text-text-muted hover:text-text-primary
                        transition-colors
                    "
                >
                    <Plus className="h-4 w-4" />
                    Add your first provider
                </button>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-border/60 bg-surface-1/40 px-4 py-3 flex flex-col gap-3">
            {/* Top row: status + test */}
            <div className="flex items-center gap-3">
                <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${statusDotColor}`} />
                <span className="text-sm text-text-primary flex-1 min-w-0 truncate">
                    {bannerLabel}
                </span>
                {bannerOk && (
                    <button
                        onClick={onTest}
                        disabled={testing}
                        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2 transition-colors shrink-0"
                    >
                        {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Test
                    </button>
                )}
            </div>

            {/* Draggable chain */}
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setActiveDragId(null)}
            >
                <SortableContext items={cards.map(c => c.id)} strategy={rectSortingStrategy}>
                    <div
                        className="
                            flex flex-wrap sm:flex-nowrap
                            gap-2 sm:gap-0
                            sm:overflow-x-auto sm:overflow-y-visible
                            pt-3 pb-1
                            -mx-1 px-1
                        "
                        role="list"
                        aria-label="Provider priority chain. Drag cards to reorder."
                    >
                        {cards.map((card, idx) => (
                            <div key={card.id} className="flex items-center shrink-0" role="listitem">
                                <SortableProviderCard
                                    card={card}
                                    position={idx + 1}
                                    isActive={card.id === activeProviderId}
                                    isSelected={card.providerType === selectedProviderType}
                                    onCardClick={onCardClick}
                                />
                                {idx < cards.length - 1 && (
                                    <ChevronRight
                                        className="hidden sm:block h-4 w-4 text-text-muted/40 mx-1 shrink-0"
                                        aria-hidden="true"
                                    />
                                )}
                            </div>
                        ))}

                        {/* Add card */}
                        <button
                            onClick={onAdd}
                            className="
                                ml-1 flex flex-col items-center justify-center gap-1
                                w-[148px] shrink-0
                                rounded-xl border border-dashed border-border/60
                                bg-transparent hover:bg-surface-2/30 hover:border-azure/50
                                text-text-muted hover:text-text-primary
                                transition-colors
                                min-h-[84px]
                                focus:outline-none focus-visible:ring-2 focus-visible:ring-azure
                            "
                            aria-label="Add another provider"
                        >
                            <Plus className="h-4 w-4" />
                            <span className="text-[11px] font-medium">Add provider</span>
                        </button>
                    </div>
                </SortableContext>

                <DragOverlay>
                    {draggingCard ? (
                        <ProviderCardOverlay card={draggingCard} position={draggingPosition} />
                    ) : null}
                </DragOverlay>
            </DndContext>

            <p className="text-[11px] text-text-muted">
                Drag to reorder · Plexo tries them left-to-right, top-to-bottom
            </p>

            {testResult && (
                <div
                    className={`
                        rounded-lg border px-3 py-2 flex items-start gap-2
                        ${testResult.ok
                            ? 'border-emerald-800/40 bg-emerald-900/10'
                            : 'border-amber-800/40 bg-amber-900/10'}
                    `}
                >
                    {testResult.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                        : <AlertCircle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />}
                    <p className={`text-xs font-medium ${testResult.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {testResult.message}
                    </p>
                </div>
            )}
        </div>
    )
}
