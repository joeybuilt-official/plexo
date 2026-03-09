// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import type { StepFileWriteEvent } from './use-code-stream'

interface DiffViewerProps {
    events: StepFileWriteEvent[]
    className?: string
}

function parsePatch(patch: string): Array<{ type: 'header' | 'add' | 'remove' | 'context'; text: string }> {
    return patch.split('\n').map((line) => {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
            return { type: 'header', text: line }
        }
        if (line.startsWith('+')) return { type: 'add', text: line }
        if (line.startsWith('-')) return { type: 'remove', text: line }
        return { type: 'context', text: line }
    })
}

function relativeTime(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 5) return 'just now'
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
}

export function DiffViewer({ events, className = '' }: DiffViewerProps) {
    if (events.length === 0) {
        return (
            <div className={`flex items-center justify-center h-full text-xs text-zinc-500 font-mono select-none ${className}`}>
                <span className="opacity-50">no file changes yet</span>
            </div>
        )
    }

    return (
        <div className={`overflow-auto h-full divide-y divide-zinc-800/50 ${className}`}>
            {events.map((ev, i) => {
                const lines = parsePatch(ev.patch)
                const addCount = lines.filter((l) => l.type === 'add').length
                const removeCount = lines.filter((l) => l.type === 'remove').length
                return (
                    <details key={i} open={i === events.length - 1}>
                        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-900/60 list-none select-text">
                            <span className="font-mono text-xs text-zinc-300 flex-1 truncate">{ev.path}</span>
                            <span className="text-xs text-emerald-400 font-mono">+{addCount}</span>
                            <span className="text-xs text-red-400 font-mono">-{removeCount}</span>
                            <span className="text-xs text-zinc-600">{relativeTime(ev.ts)}</span>
                        </summary>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs font-mono">
                                <tbody>
                                    {lines.map((l, j) => (
                                        <tr
                                            key={j}
                                            className={
                                                l.type === 'add'
                                                    ? 'bg-emerald-950/40'
                                                    : l.type === 'remove'
                                                    ? 'bg-red-950/40'
                                                    : l.type === 'header'
                                                    ? 'bg-zinc-900/60'
                                                    : ''
                                            }
                                        >
                                            <td
                                                className={`pl-3 pr-4 select-none w-4 ${
                                                    l.type === 'add'
                                                        ? 'text-emerald-400'
                                                        : l.type === 'remove'
                                                        ? 'text-red-400'
                                                        : 'text-zinc-600'
                                                }`}
                                            >
                                                {l.type === 'add' ? '+' : l.type === 'remove' ? '-' : l.type === 'header' ? '' : ' '}
                                            </td>
                                            <td className="pr-4 py-0.5 text-zinc-300 whitespace-pre">{l.text.slice(1) || l.text}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                )
            })}
        </div>
    )
}
