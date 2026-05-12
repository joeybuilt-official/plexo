import Link from 'next/link'
import { Bot, Wrench, Zap, Radio, Plug, LayoutGrid } from 'lucide-react'
import type { ElementType } from 'react'

interface TypePillsProps {
    /** Rows produced by getTypeCounts() */
    counts: { type: string; count: number }[]
    /** Currently active type key (or undefined for "all"). */
    active?: string
    /** Base href that other filters (category/sort/q) should survive on. */
    baseParams: Record<string, string | undefined>
}

const TYPE_META: Record<string, { label: string; icon: ElementType; accent: string }> = {
    agent: { label: 'Agents', icon: Bot, accent: 'text-violet-400' },
    tool: { label: 'Tools', icon: Wrench, accent: 'text-amber-400' },
    skill: { label: 'Skills', icon: Zap, accent: 'text-azure' },
    function: { label: 'Tools', icon: Wrench, accent: 'text-amber-400' },
    channel: { label: 'Channels', icon: Radio, accent: 'text-green-400' },
    connector: { label: 'Connectors', icon: Plug, accent: 'text-rose-400' },
    'mcp-server': { label: 'Connectors', icon: Plug, accent: 'text-rose-400' },
}

// Canonical display order for the pills.
const ORDER = ['agent', 'tool', 'skill', 'channel', 'connector', 'mcp-server']

function buildHref(base: Record<string, string | undefined>, type: string | null): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(base)) {
        if (k === 'type') continue
        if (v) params.set(k, v)
    }
    if (type) params.set('type', type)
    const qs = params.toString()
    return `/browse${qs ? `?${qs}` : ''}`
}

export function TypePills({ counts, active, baseParams }: TypePillsProps) {
    // Build a combined count map; merge "function" into "tool".
    const map = new Map<string, number>()
    let total = 0
    for (const row of counts) {
        const normalized = row.type === 'function' ? 'tool' : row.type
        map.set(normalized, (map.get(normalized) ?? 0) + row.count)
        total += row.count
    }

    const allActive = !active || active === 'all'

    return (
        <div className="flex flex-wrap gap-2">
            <Link
                href={buildHref(baseParams, null)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    allActive
                        ? 'bg-azure-dim text-azure glow-border'
                        : 'bg-surface-1/40 text-text-muted glow-border hover:text-text-secondary'
                }`}
            >
                <LayoutGrid className="h-3.5 w-3.5" />
                All
                <span className="text-xs opacity-50 tabular-nums">{total}</span>
            </Link>
            {ORDER.map((t) => {
                const meta = TYPE_META[t]
                if (!meta) return null
                const count = map.get(t) ?? 0
                if (count === 0) return null
                const isActive = active === t
                const Icon = meta.icon
                const isAgent = t === 'agent'
                return (
                    <Link
                        key={t}
                        href={buildHref(baseParams, t)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                            isActive
                                ? isAgent
                                    ? 'bg-violet-500/15 text-violet-300 glow-border'
                                    : 'bg-azure-dim text-azure glow-border'
                                : 'bg-surface-1/40 text-text-muted glow-border hover:text-text-secondary'
                        }`}
                    >
                        <Icon className={`h-3.5 w-3.5 ${isActive ? '' : meta.accent}`} />
                        {meta.label}
                        <span className="text-xs opacity-50 tabular-nums">{count}</span>
                    </Link>
                )
            })}
        </div>
    )
}
