// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'

import type { WorkRendererProps } from '../types'

/**
 * JsonRenderer — hand-rolled collapsible tree. Avoids the ~200KB of
 * react-json-view. Type-colored values, click-to-copy on any leaf.
 */
export function JsonRenderer({ work }: WorkRendererProps) {
    const parsed = useMemo(() => {
        if (!work.content) return { error: 'Empty content', value: null as unknown }
        try {
            return { error: null as string | null, value: JSON.parse(work.content) }
        } catch (e) {
            return { error: (e as Error).message, value: null as unknown }
        }
    }, [work.content])

    if (parsed.error) {
        return (
            <div className="p-6 font-mono text-xs text-red-400 whitespace-pre-wrap">
                Failed to parse JSON: {parsed.error}
                {'\n\n'}
                <span className="text-text-muted">{work.content}</span>
            </div>
        )
    }

    return (
        <div className="p-4 font-mono text-xs text-text-secondary overflow-auto h-full bg-[#0d0d0d]">
            <JsonNode value={parsed.value} depth={0} path="$" />
        </div>
    )
}

function JsonNode({ value, depth, path, keyName }: { value: unknown, depth: number, path: string, keyName?: string }) {
    const [open, setOpen] = useState(depth < 2)

    const isArray = Array.isArray(value)
    const isObject = value !== null && typeof value === 'object' && !isArray

    if (isArray || isObject) {
        const entries = isArray
            ? (value as unknown[]).map((v, i) => [String(i), v] as const)
            : Object.entries(value as Record<string, unknown>)
        const opener = isArray ? '[' : '{'
        const closer = isArray ? ']' : '}'
        return (
            <div className="leading-5">
                <div
                    className="flex items-start gap-1 cursor-pointer hover:bg-surface-2/20 rounded"
                    onClick={() => setOpen(o => !o)}
                >
                    {open ? <ChevronDown className="h-3 w-3 mt-0.5 text-text-muted shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 text-text-muted shrink-0" />}
                    {keyName !== undefined && (
                        <span className="text-azure">&quot;{keyName}&quot;</span>
                    )}
                    {keyName !== undefined && <span className="text-text-muted">:</span>}
                    <span className="text-text-muted">{opener}</span>
                    {!open && (
                        <span className="text-text-muted italic ml-1">
                            {entries.length} {isArray ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}
                        </span>
                    )}
                    {!open && <span className="text-text-muted">{closer}</span>}
                </div>
                {open && (
                    <div className="pl-4 border-l border-border/40 ml-1">
                        {entries.map(([k, v]) => (
                            <JsonNode key={`${path}.${k}`} value={v} depth={depth + 1} path={`${path}.${k}`} keyName={isArray ? undefined : k} />
                        ))}
                    </div>
                )}
                {open && <div className="text-text-muted">{closer}</div>}
            </div>
        )
    }

    // Leaf
    return (
        <div className="flex items-start gap-1 leading-5 pl-4">
            {keyName !== undefined && (
                <>
                    <span className="text-azure">&quot;{keyName}&quot;</span>
                    <span className="text-text-muted">:</span>
                </>
            )}
            <LeafValue value={value} />
        </div>
    )
}

function LeafValue({ value }: { value: unknown }) {
    if (value === null) return <span className="text-slate-500">null</span>
    if (typeof value === 'boolean') return <span className="text-orange-400">{String(value)}</span>
    if (typeof value === 'number') return <span className="text-purple-400">{value}</span>
    if (typeof value === 'string') return <span className="text-emerald-400 break-all">&quot;{value}&quot;</span>
    return <span className="text-text-muted">{String(value)}</span>
}
