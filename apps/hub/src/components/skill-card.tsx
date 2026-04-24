import Link from 'next/link'
import { Download, Bot, Zap, Wrench, Radio, Plug, Clock } from 'lucide-react'

const TYPE_BADGE: Record<string, { label: string; color: string; icon: typeof Bot; ring: string; iconAccent: string }> = {
    agent: {
        label: 'Agent',
        color: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
        icon: Bot,
        ring: 'ring-1 ring-violet-500/30',
        iconAccent: 'text-violet-400',
    },
    skill: {
        label: 'Skill',
        color: 'bg-azure-dim text-azure border border-azure/30',
        icon: Zap,
        ring: '',
        iconAccent: 'text-azure',
    },
    tool: {
        label: 'Tool',
        color: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        icon: Wrench,
        ring: '',
        iconAccent: 'text-amber-400',
    },
    function: {
        label: 'Tool',
        color: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        icon: Wrench,
        ring: '',
        iconAccent: 'text-amber-400',
    },
    channel: {
        label: 'Channel',
        color: 'bg-green-500/15 text-green-400 border border-green-500/30',
        icon: Radio,
        ring: '',
        iconAccent: 'text-green-400',
    },
    connector: {
        label: 'Connector',
        color: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
        icon: Plug,
        ring: '',
        iconAccent: 'text-rose-400',
    },
    'mcp-server': {
        label: 'Connector',
        color: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
        icon: Plug,
        ring: '',
        iconAccent: 'text-rose-400',
    },
}

interface SkillCardProps {
    name: string
    displayName: string
    description: string
    publisher: string
    installCount: number
    type?: string
    iconUrl?: string | null
    /** True if the manifest lacks an `entry` field — not actually installable. */
    comingSoon?: boolean
}

export function SkillCard({
    name,
    displayName,
    description,
    publisher,
    installCount,
    type,
    iconUrl,
    comingSoon = false,
}: SkillCardProps) {
    const badge = TYPE_BADGE[type ?? 'skill'] ?? TYPE_BADGE.skill
    const Icon = badge.icon
    const slug = encodeURIComponent(name)
    const isAgent = type === 'agent'

    return (
        <Link
            href={`/ext/${slug}`}
            className={`block rounded-xl bg-surface-1/50 backdrop-blur-sm p-5 glow-border transition-all hover:-translate-y-0.5 ${badge.ring} ${isAgent ? 'hover:ring-violet-500/60' : ''}`}
        >
            <div className="flex items-start gap-3.5">
                {iconUrl ? (
                    <img src={iconUrl} alt="" className="h-10 w-10 rounded-lg shrink-0" />
                ) : (
                    <div className={`h-10 w-10 rounded-lg border border-border/60 flex items-center justify-center shrink-0 ${isAgent ? 'bg-violet-500/10' : 'bg-surface-2'}`}>
                        <Icon className={`h-5 w-5 ${isAgent ? badge.iconAccent : 'text-text-muted'}`} />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text-primary truncate tracking-tight">{displayName}</h3>
                    <p className="text-xs text-text-muted mt-0.5">{publisher}</p>
                </div>
            </div>
            <p className="text-xs text-text-secondary mt-3 line-clamp-2 leading-relaxed">{description}</p>
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/30">
                <div className="flex items-center gap-1.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>
                        {badge.label}
                    </span>
                    {comingSoon && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-surface-2 text-text-muted border border-border/60">
                            <Clock className="h-2.5 w-2.5" />
                            Coming soon
                        </span>
                    )}
                </div>
                <span className="flex items-center gap-1 text-xs text-text-muted tabular-nums">
                    <Download className="h-3 w-3" />
                    {installCount.toLocaleString()}
                </span>
            </div>
        </Link>
    )
}
