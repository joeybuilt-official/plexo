import { Shield, ShieldCheck, Crown } from 'lucide-react'

const TIERS: Record<string, { label: string; icon: typeof Shield; color: string }> = {
    official: { label: 'Official', icon: Crown, color: 'text-amber bg-amber/15' },
    verified: { label: 'Verified', icon: ShieldCheck, color: 'text-azure bg-azure-dim' },
    community: { label: 'Community', icon: Shield, color: 'text-text-muted bg-surface-2' },
}

export function TrustBadge({ tier }: { tier?: string }) {
    const t = TIERS[tier ?? 'community'] ?? TIERS.community
    const Icon = t.icon
    return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${t.color}`}>
            <Icon className="h-3 w-3" />
            {t.label}
        </span>
    )
}
