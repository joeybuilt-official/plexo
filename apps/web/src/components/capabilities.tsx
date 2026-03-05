import { ModelCapability } from '@web/lib/models'
import { ImageIcon, Mic, Video, Wrench, BrainCircuit, Type } from 'lucide-react'

const CAP_META: Record<ModelCapability, { icon: React.ElementType, label: string, color: string }> = {
    text: { icon: Type, label: 'Text', color: 'text-zinc-400 border-zinc-700/50 bg-zinc-800/20' },
    image: { icon: ImageIcon, label: 'Vision', color: 'text-blue-400 border-blue-800/30 bg-blue-950/20' },
    voice: { icon: Mic, label: 'Voice', color: 'text-emerald-400 border-emerald-800/30 bg-emerald-950/20' },
    video: { icon: Video, label: 'Video', color: 'text-purple-400 border-purple-800/30 bg-purple-950/20' },
    tools: { icon: Wrench, label: 'Tools', color: 'text-amber-400 border-amber-800/30 bg-amber-950/20' },
    reasoning: { icon: BrainCircuit, label: 'Reasoning', color: 'text-indigo-400 border-indigo-800/30 bg-indigo-950/20' },
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
                    <span key={c} className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase font-bold tracking-wide border shadow-sm ${Meta.color}`} title={`Supports ${Meta.label} processing`}>
                        <Icon className="h-3 w-3" strokeWidth={2.5} />
                        {Meta.label}
                    </span>
                )
            })}
        </div>
    )
}
