// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import type { WorkRendererProps } from '../types'

interface ChecklistItem {
    index: number
    text: string
    initiallyChecked: boolean
    indent: number
}

/**
 * ChecklistRenderer — parses markdown checklist syntax (`- [ ]` / `- [x]`)
 * and renders interactive boxes. Phase 5: optimistic toggle that persists
 * to `artifacts.meta.checklistState` via PATCH
 * /api/v1/tasks/:taskId/artifacts/:artifactId/meta with localStorage
 * fallback for offline / filesystem-fallback works.
 */
export function ChecklistRenderer({ work, onAction }: WorkRendererProps) {
    const items = useMemo(() => parseChecklist(work.content ?? ''), [work.content])
    const storageKey = work.artifactId ? `plexo:checklist:${work.artifactId}` : null
    const taskId = (work as { taskId?: string }).taskId

    const [checked, setChecked] = useState<Set<number>>(() => {
        const serverState = (work.meta as { checklistState?: number[] } | undefined)?.checklistState
        if (Array.isArray(serverState)) {
            return new Set(serverState.map(Number))
        }
        const base = new Set<number>()
        items.forEach(it => { if (it.initiallyChecked) base.add(it.index) })
        return base
    })
    const [savingError, setSavingError] = useState<string | null>(null)
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (!storageKey) return
        const serverState = (work.meta as { checklistState?: number[] } | undefined)?.checklistState
        if (Array.isArray(serverState)) return
        try {
            const raw = window.localStorage.getItem(storageKey)
            if (!raw) return
            const arr = JSON.parse(raw)
            if (Array.isArray(arr)) setChecked(new Set(arr.map(Number)))
        } catch { /* ignore */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey])

    async function persist(next: Set<number>) {
        const arr = Array.from(next).sort((a, b) => a - b)
        if (storageKey) {
            try { window.localStorage.setItem(storageKey, JSON.stringify(arr)) } catch { /* ignore */ }
        }
        if (!work.artifactId || !taskId) return
        try {
            const res = await fetch(`/api/v1/tasks/${taskId}/artifacts/${work.artifactId}/meta`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ patch: { checklistState: arr } }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setSavingError(null)
        } catch (err) {
            setSavingError((err as Error).message || 'Save failed')
        }
    }

    function toggle(idx: number) {
        setChecked(prev => {
            const next = new Set(prev)
            if (next.has(idx)) next.delete(idx)
            else next.add(idx)
            if (saveTimer.current) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => persist(next), 250)
            onAction?.({ type: 'apply', target: 'checklist-item', payload: { id: idx, checked: next.has(idx) } })
            return next
        })
    }

    if (items.length === 0) {
        return (
            <div className="p-6 text-sm text-text-muted italic">
                No checklist items detected. Use <code className="text-text-primary">- [ ] item</code> syntax.
            </div>
        )
    }

    const done = Array.from(checked).filter(i => items.some(it => it.index === i)).length
    const pct = Math.round((done / items.length) * 100)

    return (
        <div className="p-6 max-w-3xl mx-auto">
            <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] uppercase tracking-wider text-text-muted">Progress</span>
                    <span className="text-[11px] text-text-primary/80">{done} / {items.length} ({pct}%)</span>
                </div>
                <div className="h-1 w-full bg-surface-1 rounded-full overflow-hidden">
                    <div className="h-full bg-azure transition-all" style={{ width: `${pct}%` }} />
                </div>
                {savingError && (
                    <div className="mt-1 text-[10px] text-red-400">Save failed: {savingError} (kept local)</div>
                )}
            </div>
            <ul className="flex flex-col gap-1">
                {items.map(item => {
                    const isChecked = checked.has(item.index)
                    return (
                        <li
                            key={item.index}
                            className="flex items-start gap-2 py-1"
                            style={{ paddingLeft: `${item.indent * 1.25}rem` }}
                        >
                            <input
                                id={`chk-${work.artifactId ?? 'x'}-${item.index}`}
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggle(item.index)}
                                className="mt-1 h-3.5 w-3.5 accent-azure cursor-pointer shrink-0"
                            />
                            <label
                                htmlFor={`chk-${work.artifactId ?? 'x'}-${item.index}`}
                                className={`text-sm cursor-pointer ${isChecked ? 'text-text-muted line-through' : 'text-text-primary'}`}
                            >
                                {item.text}
                            </label>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

export function parseChecklist(content: string): ChecklistItem[] {
    const re = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.+)$/gm
    const items: ChecklistItem[] = []
    let m: RegExpExecArray | null
    let index = 0
    while ((m = re.exec(content))) {
        const whitespace = m[1] ?? ''
        const state = m[2] ?? ' '
        const text = (m[3] ?? '').trim()
        items.push({
            index: index++,
            text,
            initiallyChecked: state.toLowerCase() === 'x',
            indent: Math.floor(whitespace.length / 2),
        })
    }
    return items
}
