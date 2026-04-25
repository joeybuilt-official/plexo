// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Intelligence (AI & Memory) settings layout.
 *
 * Presents 11 focused sub-sections in 4 groups. Status hints on each
 * row come from existing SWR hooks — SWR's in-flight dedup cache
 * ensures each endpoint is only hit once per render tree. No new
 * aggregator endpoint is introduced by this layout.
 *
 * Sub-sections live at:
 *   /app/settings/intelligence/providers
 *   /app/settings/intelligence/routing
 *   /app/settings/intelligence/routing/tasks
 *   /app/settings/intelligence/models
 *   /app/settings/intelligence/embeddings
 *   /app/settings/intelligence/memory
 *   /app/settings/intelligence/scl
 *   /app/settings/intelligence/scl/drift
 *   /app/settings/intelligence/scl/rsi
 *   /app/settings/intelligence/scl/attractors
 *   /app/settings/intelligence/self-hosted
 */

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import useSWR from 'swr'
import {
    Cable,
    Route,
    ListOrdered,
    Boxes,
    Database,
    BrainCircuit,
    Sparkles,
    AlertTriangle,
    Wand2,
    Network,
    Server,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { jsonFetcher } from '@web/lib/swr'
import {
    useIntelligenceSettings,
    useWorkspaceSpend,
    useChains,
    useModelCatalog,
} from '@web/lib/intelligence-client'
import {
    useSclSettings,
    useDriftWarnings,
    useRsiProposals,
    useAttractors,
} from '@web/lib/scl-client'
import { useMemoryNamespaces } from '@web/lib/memory-client'
import { useDetect } from '@web/lib/intelligence-dashboard-client'

// ── Types ────────────────────────────────────────────────────────────────

interface ProviderCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    discoveryError: string | null
}

interface ProviderInstance {
    id: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    capabilities: ProviderCapabilities
    managed: boolean
    enabled: boolean
    selectedModel: string | null
    lastDiscoveredAt: string | null
}

interface NavItem {
    href: string
    label: string
    icon: LucideIcon
    status: string
    badge?: number
    exact?: boolean
    group: 'providers' | 'routing' | 'memory' | 'scl' | 'advanced'
}

// ── Helpers ──────────────────────────────────────────────────────────────

function relativeTimeShort(iso: string | null | undefined): string {
    if (!iso) return '—'
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
}

function formatUsd(n: number | null | undefined): string {
    if (n == null || Number.isNaN(n)) return '—'
    if (n === 0) return '$0'
    if (n < 1) return `$${n.toFixed(2)}`
    return `$${Math.round(n)}`
}

function isProviderHealthy(p: ProviderInstance): boolean {
    if (!p.enabled) return false
    if (p.capabilities?.discoveryError) return false
    if (!p.lastDiscoveredAt) return false
    return true
}

// ── Layout ───────────────────────────────────────────────────────────────

const GROUP_LABELS: Record<NavItem['group'], string> = {
    providers: 'Providers',
    routing: 'Routing',
    memory: 'Memory',
    scl: 'Semantic Concept Lattice',
    advanced: 'Advanced',
}

export default function IntelligenceLayout({ children }: { children: ReactNode }) {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null
    const pathname = usePathname() || ''

    // ── Probes ──────────────────────────────────────────────────────────
    // 1. Providers list (reuse the same endpoint the megapage used).
    const providersKey = workspaceId
        ? `/api/v1/workspaces/${workspaceId}/providers`
        : null
    const { data: providersData } = useSWR<{ providers?: ProviderInstance[]; items?: ProviderInstance[] }>(
        providersKey,
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )
    const providers: ProviderInstance[] = useMemo(() => {
        const raw = providersData?.providers ?? providersData?.items ?? []
        return raw.map((p) => ({
            ...p,
            capabilities: p.capabilities ?? {
                supportsChat: false,
                supportsEmbeddings: false,
                chatModels: [],
                embeddingModels: [],
                discoveryError: null,
            },
        }))
    }, [providersData])

    // 2. Intelligence settings + spend
    const { data: settingsData } = useIntelligenceSettings(workspaceId)
    const { data: spendData } = useWorkspaceSpend(workspaceId)

    // 3. Chains
    const { data: chainsData } = useChains(workspaceId)

    // 4. Model catalog (just the total count)
    const { data: catalogData } = useModelCatalog({ pageSize: 1 })

    // 5. Detect probe (for bundled embeddings server reachability)
    const { data: detectData } = useDetect(workspaceId)

    // 6. Memory namespace/tier counts
    const { data: namespacesData } = useMemoryNamespaces(workspaceId)

    // 7. SCL settings
    const { data: sclData } = useSclSettings(workspaceId)

    // 8/9. Drift + RSI pending counts
    const { data: driftData } = useDriftWarnings(workspaceId, 'pending')
    const { data: rsiData } = useRsiProposals(workspaceId, 'pending')

    // 10. Attractors
    const { data: attractorsData } = useAttractors(workspaceId, { limit: 1 })

    // ── Derived status strings ──────────────────────────────────────────

    // Providers row: {activeLabel} · {enabledCount} connected
    const providersStatus = useMemo(() => {
        if (!providersData) return '—'
        const byo = providers.filter((p) => p.enabled && !p.managed)
        const firstHealthy = byo.find(isProviderHealthy)
        const activeLabel = firstHealthy
            ? `${firstHealthy.providerType} · ${firstHealthy.selectedModel ?? firstHealthy.capabilities.chatModels?.[0] ?? firstHealthy.providerType}`
            : byo.length > 0
                ? 'Degraded'
                : 'None active'
        return `${activeLabel} · ${byo.length} connected`
    }, [providersData, providers])

    // Inference mode & cost
    const routingStatus = useMemo(() => {
        if (!settingsData || !spendData) return '—'
        const mode = settingsData.settings.inferenceMode
        const spent = spendData.spend.pricedUsd
        const ceiling = settingsData.settings.costCeilingUsd
        return `${mode} · ${formatUsd(spent)} / ${ceiling != null ? formatUsd(ceiling) : '∞'} this month`
    }, [settingsData, spendData])

    // Chains
    const chainsStatus = useMemo(() => {
        if (!chainsData) return '—'
        let configured = 0
        for (const key of Object.keys(chainsData.chains ?? {})) {
            const entries = chainsData.chains[key as keyof typeof chainsData.chains] ?? []
            if (entries.length > 0) configured += 1
        }
        return `${configured} task types configured`
    }, [chainsData])

    // Model catalog
    const modelsStatus = useMemo(() => {
        if (!catalogData) return '—'
        const ts = catalogData.items?.[0]?.lastSyncedAt
        return `${catalogData.total} models · refreshed ${relativeTimeShort(ts)}`
    }, [catalogData])

    // Embeddings primary
    const embeddingsStatus = useMemo(() => {
        if (!detectData) return '—'
        const localUp = detectData.services?.embeddings?.status === 'up'
        if (localUp) {
            return 'Local: snowflake-arctic-embed-s'
        }
        const byo = providers.find(
            (p) =>
                p.enabled
                && !p.managed
                && p.capabilities?.supportsEmbeddings,
        )
        if (byo) {
            const model = byo.capabilities.embeddingModels?.[0] ?? byo.providerType
            return `BYO: ${byo.providerType} · ${model}`
        }
        return 'Not configured'
    }, [detectData, providers])

    // Memory
    const memoryStatus = useMemo(() => {
        if (!namespacesData) return '—'
        let hot = 0
        let active = 0
        let cold = 0
        for (const row of namespacesData.namespaces ?? []) {
            hot += row.hot ?? 0
            active += row.active ?? 0
            cold += row.cold ?? 0
        }
        return `${hot} hot · ${active} active · ${cold} cold`
    }, [namespacesData])

    // SCL — always on
    const sclStatus = useMemo(() => {
        if (!sclData) return '—'
        const { driftThreshold, expandDepth } = sclData.settings
        return `On · drift ${driftThreshold} · depth ${expandDepth}`
    }, [sclData])

    // Drift + RSI
    const driftPending = driftData?.warnings?.length ?? 0
    const rsiPending = rsiData?.proposals?.length ?? 0
    const driftStatus = driftData ? `${driftPending} pending` : '—'
    const rsiStatus = rsiData ? `${rsiPending} pending` : '—'

    // Attractors
    const attractorsStatus = useMemo(() => {
        if (!attractorsData) return '—'
        // Mindsets: we don't have a direct count; fall back to total of
        // distinct mindset objects being 1:1 with attractors in v1.
        const total = attractorsData.total ?? 0
        return `${total} attractors · ${total} mindsets`
    }, [attractorsData])

    // Self-hosted
    const selfHostedStatus = useMemo(() => {
        if (!providersData) return '—'
        const n = providers.filter((p) => !!p.endpointUrl && !p.managed).length
        return `${n} configured`
    }, [providersData, providers])

    // ── Build nav ───────────────────────────────────────────────────────

    const nav: NavItem[] = useMemo(() => {
        const items: NavItem[] = [
            {
                href: '/app/settings/intelligence/providers',
                label: 'Providers',
                icon: Cable,
                status: providersStatus,
                group: 'providers',
            },
            {
                href: '/app/settings/intelligence/routing',
                label: 'Inference mode & cost',
                icon: Route,
                status: routingStatus,
                group: 'routing',
            },
            {
                href: '/app/settings/intelligence/routing/tasks',
                label: 'Per-task chains',
                icon: ListOrdered,
                status: chainsStatus,
                group: 'routing',
            },
            {
                href: '/app/settings/intelligence/models',
                label: 'Model catalog',
                icon: Boxes,
                status: modelsStatus,
                group: 'routing',
            },
            {
                href: '/app/settings/intelligence/embeddings',
                label: 'Embeddings',
                icon: Sparkles,
                status: embeddingsStatus,
                group: 'memory',
            },
            {
                href: '/app/settings/intelligence/memory',
                label: 'Memory browser',
                icon: Database,
                status: memoryStatus,
                group: 'memory',
            },
        ]
        items.push(
            {
                href: '/app/settings/intelligence/scl',
                label: 'SCL settings',
                icon: BrainCircuit,
                status: sclStatus,
                group: 'scl',
                exact: true,
            },
            {
                href: '/app/settings/intelligence/scl/drift',
                label: 'Drift inbox',
                icon: AlertTriangle,
                status: driftStatus,
                badge: driftPending,
                group: 'scl',
            },
            {
                href: '/app/settings/intelligence/scl/rsi',
                label: 'RSI proposals',
                icon: Wand2,
                status: rsiStatus,
                badge: rsiPending,
                group: 'scl',
            },
            {
                href: '/app/settings/intelligence/scl/attractors',
                label: 'Attractors',
                icon: Network,
                status: attractorsStatus,
                group: 'scl',
            },
        )
        items.push({
            href: '/app/settings/intelligence/self-hosted',
            label: 'Self-hosted servers',
            icon: Server,
            status: selfHostedStatus,
            group: 'advanced',
        })
        return items
    }, [
        providersStatus,
        routingStatus,
        chainsStatus,
        modelsStatus,
        embeddingsStatus,
        memoryStatus,
        sclStatus,
        driftStatus,
        driftPending,
        rsiStatus,
        rsiPending,
        attractorsStatus,
        selfHostedStatus,
    ])

    // Group rows while preserving order
    const grouped = useMemo(() => {
        const order: NavItem['group'][] = ['providers', 'routing', 'memory', 'scl', 'advanced']
        const map = new Map<NavItem['group'], NavItem[]>()
        for (const g of order) map.set(g, [])
        for (const item of nav) map.get(item.group)!.push(item)
        return order.map((g) => ({ group: g, items: map.get(g)! }))
    }, [nav])

    function isActive(href: string, exact?: boolean): boolean {
        if (pathname === href) return true
        if (exact) return false
        return pathname.startsWith(`${href}/`)
    }

    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-2xl font-medium text-text-primary">AI &amp; Memory</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Providers, routing, memory, and semantic context — all in one place
                    </p>
                </div>
            </div>

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pt-2 pb-4 md:pb-0">
                {/* Left rail */}
                <nav
                    aria-label="Intelligence settings"
                    className="w-full md:w-[280px] shrink-0 overflow-y-auto pb-2 md:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
                >
                    <div className="flex flex-col gap-4">
                        {grouped.map(({ group, items }) => {
                            if (items.length === 0) return null
                            return (
                                <div key={group} className="flex flex-col gap-1">
                                    <div className="px-2 text-[10px] uppercase tracking-wider text-text-muted">
                                        {GROUP_LABELS[group]}
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        {items.map((item) => {
                                            const Icon = item.icon
                                            const active = isActive(item.href, item.exact)
                                            const showBadge = item.badge != null && item.badge > 0
                                            return (
                                                <Link
                                                    key={item.href}
                                                    href={item.href}
                                                    className={`block rounded-sm border px-3 py-2.5 transition-all text-sm min-h-[44px] ${
                                                        active
                                                            ? 'border-azure/50 bg-surface-1'
                                                            : 'border-border/60 bg-surface-1/30 hover:border-border hover:bg-surface-1/60'
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="flex items-center gap-2.5 min-w-0">
                                                            <Icon className="h-4 w-4 text-text-muted shrink-0" />
                                                            <span className={`text-sm font-medium truncate ${active ? 'text-text-primary' : 'text-text-primary'}`}>
                                                                {item.label}
                                                            </span>
                                                        </div>
                                                        {showBadge && (
                                                            <span className="rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-amber-300 bg-amber-950/30 border border-amber-800/40 shrink-0">
                                                                {item.badge}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-0.5 text-[11px] text-text-muted truncate">
                                                        {item.status}
                                                    </div>
                                                </Link>
                                            )
                                        })}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </nav>

                {/* Detail slot */}
                <div className="flex-1 rounded-sm border border-border bg-surface-1/40 flex flex-col overflow-hidden min-h-0 max-w-[100vw] sm:max-w-none">
                    {children}
                </div>
            </div>
        </div>
    )
}
