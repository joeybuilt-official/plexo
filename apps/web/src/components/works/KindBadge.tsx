// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { WorkKind } from './types'

// Colour palette uses existing Plexo tokens so we stay on the single
// theme system. Each kind gets a label + semantic colour.
const KIND_STYLE: Record<WorkKind, { label: string, className: string }> = {
    markdown:     { label: 'DOC',          className: 'bg-azure/10 text-azure border-azure/30' },
    instructions: { label: 'INSTRUCTIONS', className: 'bg-azure/10 text-azure border-azure/30' },
    code:         { label: 'CODE',         className: 'bg-signal-green/10 text-emerald-400 border-signal-green/30' },
    html:         { label: 'HTML',         className: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
    mockup:       { label: 'MOCKUP',       className: 'bg-pink-500/10 text-pink-400 border-pink-500/30' },
    json:         { label: 'JSON',         className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
    yaml:         { label: 'YAML',         className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
    table:        { label: 'TABLE',        className: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' },
    checklist:    { label: 'CHECKLIST',    className: 'bg-signal-green/10 text-emerald-400 border-signal-green/30' },
    image:        { label: 'IMAGE',        className: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
    diagram:      { label: 'DIAGRAM',      className: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
    chart:        { label: 'CHART',        className: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' },
    config:       { label: 'CONFIG',       className: 'bg-slate-500/10 text-slate-300 border-slate-500/30' },
    'link-list':  { label: 'LINKS',        className: 'bg-azure/10 text-azure border-azure/30' },
    file:         { label: 'FILE',         className: 'bg-slate-500/10 text-slate-300 border-slate-500/30' },
}

export function KindBadge({ kind, size = 'sm' }: { kind: WorkKind, size?: 'xs' | 'sm' }) {
    const style = KIND_STYLE[kind] ?? KIND_STYLE.file
    const sizeCls = size === 'xs'
        ? 'text-[9px] px-1 py-[1px]'
        : 'text-[10px] px-1.5 py-0.5'
    return (
        <span className={`inline-flex items-center rounded border font-semibold tracking-wider uppercase ${sizeCls} ${style.className}`}>
            {style.label}
        </span>
    )
}
