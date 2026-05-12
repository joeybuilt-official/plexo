// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, Search, Clipboard, Check } from 'lucide-react'

import type { WorkRendererProps } from '../types'

/**
 * TableRenderer — parses CSV / TSV / JSON-array content into a sortable,
 * filterable table. Phase 5 adds row filter input and copy-as-CSV button.
 */
export function TableRenderer({ work, onAction }: WorkRendererProps) {
    const { columns, rows, error } = useMemo(() => parseTabular(work), [work])

    const [sort, setSort] = useState<{ col: string, dir: 'asc' | 'desc' } | null>(null)
    const [filter, setFilter] = useState('')
    const [copied, setCopied] = useState(false)

    const filtered = useMemo(() => {
        if (!rows) return rows
        if (!filter.trim()) return rows
        const needle = filter.toLowerCase()
        return rows.filter(row =>
            Object.values(row).some(v => v != null && String(v).toLowerCase().includes(needle))
        )
    }, [rows, filter])

    const sorted = useMemo(() => {
        if (!sort || !filtered) return filtered
        const copy = filtered.slice()
        copy.sort((a, b) => {
            const av = a[sort.col]
            const bv = b[sort.col]
            if (av == null && bv == null) return 0
            if (av == null) return 1
            if (bv == null) return -1
            const an = Number(av), bn = Number(bv)
            if (!Number.isNaN(an) && !Number.isNaN(bn)) return sort.dir === 'asc' ? an - bn : bn - an
            const as = String(av), bs = String(bv)
            return sort.dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
        })
        return copy
    }, [filtered, sort])

    function copyCsv() {
        if (!columns || !sorted) return
        const csv = toCsv(columns, sorted)
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(csv).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
                onAction?.({ type: 'copy', content: csv })
            }).catch(() => {
                onAction?.({ type: 'copy', content: csv })
            })
        } else {
            onAction?.({ type: 'copy', content: csv })
        }
    }

    if (error) {
        return (
            <div className="p-6 font-mono text-xs text-red-400">
                Failed to parse tabular content: {error}
            </div>
        )
    }

    if (!columns || !sorted || columns.length === 0) {
        return (
            <div className="p-6 text-sm text-text-muted italic">No tabular data detected.</div>
        )
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border bg-surface-1/50">
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-text-muted" />
                    <input
                        type="text"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Filter rows…"
                        className="w-full pl-7 pr-2 py-1 rounded-md bg-surface-1 border border-border text-[11px] text-text-primary placeholder:text-text-muted focus-ring focus:border-azure/60"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-muted">
                        {sorted.length}{filter.trim() ? ` / ${rows!.length}` : ''} rows
                    </span>
                    <button
                        onClick={copyCsv}
                        className="rounded-md bg-surface-1 border border-border px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-surface-1/80 transition-colors flex items-center gap-1.5"
                        title="Copy as CSV"
                    >
                        {copied ? <Check className="h-3 w-3 text-azure" /> : <Clipboard className="h-3 w-3" />}
                        {copied ? 'Copied' : 'Copy CSV'}
                    </button>
                </div>
            </div>
            <div className="overflow-auto flex-1 p-2">
                <table className="w-full text-xs font-mono border-collapse">
                    <thead className="sticky top-0 bg-surface-1 z-10">
                        <tr>
                            {columns.map(col => (
                                <th
                                    key={col}
                                    className="text-left px-3 py-2 border-b border-border text-text-primary font-semibold uppercase tracking-wider cursor-pointer hover:bg-surface-1/80"
                                    onClick={() => setSort(prev =>
                                        prev?.col === col
                                            ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                                            : { col, dir: 'asc' }
                                    )}
                                >
                                    <div className="flex items-center gap-1">
                                        {col}
                                        {sort?.col === col && (
                                            sort.dir === 'asc'
                                                ? <ChevronUp className="h-3 w-3" />
                                                : <ChevronDown className="h-3 w-3" />
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row, i) => (
                            <tr key={i} className="hover:bg-surface-1/30">
                                {columns.map(col => (
                                    <td key={col} className="px-3 py-1.5 border-b border-border/40 text-text-primary/90">
                                        {formatCell(row[col])}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

function formatCell(v: unknown): string {
    if (v == null) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
    const escape = (v: unknown): string => {
        if (v == null) return ''
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`
        }
        return s
    }
    const header = columns.map(escape).join(',')
    const body = rows.map(r => columns.map(c => escape(r[c])).join(',')).join('\n')
    return body ? `${header}\n${body}` : header
}

export function parseTabular(work: { filename: string, content: string | null, meta?: Record<string, unknown> }):
    { columns: string[] | null, rows: Array<Record<string, unknown>> | null, error: string | null }
{
    try {
        const metaCols = work.meta?.columns
        const metaRows = work.meta?.rows
        if (Array.isArray(metaCols) && Array.isArray(metaRows)) {
            return { columns: metaCols.map(String), rows: metaRows as Array<Record<string, unknown>>, error: null }
        }
        if (!work.content) return { columns: null, rows: null, error: null }

        const trimmed = work.content.trim()
        if (trimmed.startsWith('[')) {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed) && parsed.length > 0) {
                const cols = Array.from(new Set(parsed.flatMap(r => r && typeof r === 'object' ? Object.keys(r) : [])))
                return { columns: cols, rows: parsed, error: null }
            }
        }

        const ext = (work.filename.split('.').pop() || '').toLowerCase()
        const delim = ext === 'tsv' || trimmed.includes('\t') ? '\t' : ','
        const lines = trimmed.split(/\r?\n/).filter(Boolean)
        if (lines.length === 0) return { columns: null, rows: null, error: null }

        const header = parseCsvLine(lines[0]!, delim)
        const body = lines.slice(1).map(l => parseCsvLine(l, delim))
        const rows = body.map(cells => {
            const obj: Record<string, unknown> = {}
            header.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return obj
        })
        return { columns: header, rows, error: null }
    } catch (e) {
        return { columns: null, rows: null, error: (e as Error).message }
    }
}

function parseCsvLine(line: string, delim: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
            else if (ch === '"') { inQuotes = false }
            else { cur += ch }
        } else {
            if (ch === '"') { inQuotes = true }
            else if (ch === delim) { out.push(cur); cur = '' }
            else { cur += ch }
        }
    }
    out.push(cur)
    return out
}
