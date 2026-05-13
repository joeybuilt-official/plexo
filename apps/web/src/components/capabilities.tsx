// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { ModelCapability } from '@web/lib/models'
import { Image as ImageIcon, Mic, Video, Wrench, BrainCircuit, Type } from 'lucide-react'

const CAP_META: Record<ModelCapability, { icon: React.ElementType, label: string, color: string }> = {
    text: { icon: Type, label: 'Text', color: 'text-text-secondary border-border/50 bg-surface-2/20' },
    image: { icon: ImageIcon, label: 'Vision', color: 'text-azure border-azure-800/30 bg-azure-dim' },
    voice: { icon: Mic, label: 'Voice', color: 'text-azure border-azure-600/30 bg-azure-dim' },
    video: { icon: Video, label: 'Video', color: 'text-purple-400 border-purple-800/30 bg-surface-2' },
    tools: { icon: Wrench, label: 'Tools', color: 'text-amber border-amber-800/30 bg-amber-dim' },
    reasoning: { icon: BrainCircuit, label: 'Reasoning', color: 'text-azure border-azure-600/30 bg-azure-dim' },
}

export function CapabilityList({ caps, className = '' }: { caps: ModelCapability[]; className?: string }) {
    if (!caps || caps.length === 0) return null
    return (
        <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
            {caps.map(c => {
                const Meta = CAP_META[c]
                if (!Meta) return null
                const Icon = Meta.icon
                return (
                    <span key={c} className={`flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] uppercase font-medium tracking-wide border ${Meta.color}`} title={`Supports ${Meta.label} processing`}>
                        <Icon className="h-3 w-3" strokeWidth={2.5} />
                        {Meta.label}
                    </span>
                )
            })}
        </div>
    )
}
