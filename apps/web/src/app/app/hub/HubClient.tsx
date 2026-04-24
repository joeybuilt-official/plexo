// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HubClient — in-app Hub browse + install experience.
 *
 * Renders the full published extension catalog joined with installation
 * status for the current workspace. Uses ConfigListLayout so the page
 * shares a single two-column pattern with Channels / Integrations /
 * AI Models.
 */

'use client'

export const dynamic = 'force-dynamic'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import useSWR from 'swr'
import { jsonFetcher } from '@web/lib/swr'
import { toast } from 'sonner'
import {
    Bot, Wrench, Sparkles, Radio, Plug, Database,
    ExternalLink, RefreshCw, CheckCircle2, Circle, Clock,
    ShieldCheck, Download, Loader2, AlertCircle, Package,
    ThumbsUp, ThumbsDown, ChevronDown, ChevronRight, HelpCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ConfigListLayout } from '@web/components/config-list-layout'
import { useListFilter } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { useWorkspace } from '@web/context/workspace'
import { useConfirm } from '@web/components/ui/confirm-dialog'

// ── Types ────────────────────────────────────────────────────────────────────

interface HubItem {
    slug: string
    name: string
    displayName: string
    description: string
    type: string
    version: string
    manifest: Record<string, unknown>
    trust: 'verified' | 'community'
    publisher: string
    installCount: number
    updatedAt: string
    iconUrl: string | null
    category: string
    tags: string[]
    sourceUrl?: string | null
    sourceAuthor?: string | null
    sourceLicense?: string | null
    sourceRepo?: string | null
    upvotes?: number
    downvotes?: number
    score?: number
    userVote?: 'up' | 'down' | null
    installStatus: 'installed' | 'not_installed' | 'coming_soon' | 'incompatible'
    installedExtensionId?: string
    enabled?: boolean
}

// ── Type metadata ────────────────────────────────────────────────────────────

interface TypeMeta {
    label: string
    plural: string
    icon: LucideIcon
    iconColor: string
    iconBg: string
    badge: string
    tooltip: string
}

const TYPE_META: Record<string, TypeMeta> = {
    agent: {
        label: 'Agent',
        plural: 'Agents',
        icon: Bot,
        iconColor: 'text-violet-400',
        iconBg: 'bg-violet-500/10',
        badge: 'bg-violet-500/15 text-violet-300 border border-violet-500/30',
        tooltip: 'Specialized persona that enhances your primary agent with domain expertise',
    },
    tool: {
        label: 'Tool',
        plural: 'Tools',
        icon: Wrench,
        iconColor: 'text-amber-400',
        iconBg: 'bg-amber-500/10',
        badge: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
        tooltip: 'Single-purpose function an agent calls on demand',
    },
    skill: {
        label: 'Skill',
        plural: 'Skills',
        icon: Sparkles,
        iconColor: 'text-azure',
        iconBg: 'bg-azure/10',
        badge: 'bg-azure/15 text-azure border border-azure/30',
        tooltip: 'Capability package adding knowledge, prompts, or workflows',
    },
    channel: {
        label: 'Channel',
        plural: 'Channels',
        icon: Radio,
        iconColor: 'text-green-400',
        iconBg: 'bg-green-500/10',
        badge: 'bg-green-500/15 text-green-300 border border-green-500/30',
        tooltip: 'Messaging bridge connecting your agent to external platforms',
    },
    connector: {
        label: 'Connector',
        plural: 'Connectors',
        icon: Plug,
        iconColor: 'text-rose-400',
        iconBg: 'bg-rose-500/10',
        badge: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
        tooltip: 'Bridges an external MCP server into your workspace',
    },
    'mcp-server': {
        label: 'Connector',
        plural: 'Connectors',
        icon: Plug,
        iconColor: 'text-rose-400',
        iconBg: 'bg-rose-500/10',
        badge: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
        tooltip: 'Bridges an external MCP server into your workspace',
    },
    function: {
        label: 'Tool',
        plural: 'Tools',
        icon: Wrench,
        iconColor: 'text-amber-400',
        iconBg: 'bg-amber-500/10',
        badge: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
        tooltip: 'Single-purpose function an agent calls on demand',
    },
}

const FALLBACK_META: TypeMeta = {
    label: 'Extension',
    plural: 'Extensions',
    icon: Package,
    iconColor: 'text-text-muted',
    iconBg: 'bg-surface-2',
    badge: 'bg-surface-2 text-text-muted border border-border',
    tooltip: 'Installable extension for your workspace',
}

function metaFor(type: string): TypeMeta {
    return TYPE_META[type] ?? FALLBACK_META
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

const FILTER_KEYS = ['type', 'status', 'trust', 'category', 'publisher'] as const

// Human labels for registry category slugs. Unknown slugs fall back to
// titlecase of the raw value so a new DB category doesn't break the UI.
const CATEGORY_LABELS: Record<string, string> = {
    agent: 'Agents',
    code: 'Code & Engineering',
    design: 'Design',
    marketing: 'Marketing',
    ops: 'Operations',
    product: 'Product',
    productivity: 'Productivity',
    research: 'Research',
    sales: 'Sales',
    testing: 'Testing',
    other: 'Other',
}

function categoryLabel(slug: string): string {
    if (CATEGORY_LABELS[slug]) return CATEGORY_LABELS[slug]
    return slug.replace(/(^|[-_\s])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase())
}

function publisherLabel(slug: string): string {
    if (slug === '@plexo' || slug === 'plexo') return 'Plexo'
    if (slug === '@joeybuilt' || slug === 'joeybuilt') return 'Joeybuilt'
    return slug
}

function extractErrorMessage(err: unknown): string {
    if (!err) return 'Unknown error'
    if (typeof err === 'string') return err
    if (typeof err === 'object') {
        const obj = err as Record<string, unknown>
        if (typeof obj.message === 'string') return obj.message
        if (typeof obj.error === 'object' && obj.error) {
            const inner = obj.error as Record<string, unknown>
            if (typeof inner.message === 'string') return inner.message
        }
        if (typeof obj.error === 'string') return obj.error
    }
    return 'Unknown error'
}

function manifestArr(manifest: Record<string, unknown>, key: string): string[] {
    const v = manifest[key]
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    return []
}

function manifestToolNames(manifest: Record<string, unknown>): string[] {
    const tools = manifest.tools
    if (!Array.isArray(tools)) return []
    return tools
        .map((t) => {
            if (t && typeof t === 'object' && 'name' in t) return String((t as Record<string, unknown>).name ?? '')
            return typeof t === 'string' ? t : ''
        })
        .filter((s) => s.length > 0)
}

// ── Taxonomy explainer ───────────────────────────────────────────────────────

const TAXONOMY_ENTRIES: { type: string; description: string }[] = [
    { type: 'skill',      description: 'Operating instructions that guide how the agent works. Playbooks, checklists, workflows.' },
    { type: 'tool',       description: 'Code that gives the agent new actions. PDF generation, image processing, data transforms.' },
    { type: 'agent',      description: 'Specialized personas that enhance your primary agent with domain expertise. They add skills and rules, not separate agents.' },
    { type: 'connector',  description: 'Connectors to external services. Notion, Stripe, GitHub, Slack.' },
    { type: 'channel',    description: 'Communication endpoints. How you talk to Plexo.' },
]

function TaxonomyExplainer() {
    const [open, setOpen] = useState(false)
    return (
        <div className="rounded-xl border border-border/50 bg-surface-1/30">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
            >
                <HelpCircle className="h-3.5 w-3.5 text-text-muted shrink-0" />
                <span className="text-xs font-medium text-text-secondary flex-1">What are these extension types?</span>
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 text-text-muted shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-text-muted shrink-0" />}
            </button>
            {open && (
                <div className="border-t border-border/40 px-4 py-3 grid gap-2">
                    {TAXONOMY_ENTRIES.map((entry) => {
                        const meta = metaFor(entry.type)
                        const Icon = meta.icon
                        return (
                            <div key={entry.type} className="flex items-start gap-2.5">
                                <div className={`h-6 w-6 shrink-0 rounded-md flex items-center justify-center ${meta.iconBg}`}>
                                    <Icon className={`h-3 w-3 ${meta.iconColor}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <span className="text-xs font-semibold text-text-primary">{meta.label}</span>
                                    <span className="text-xs text-text-muted ml-1.5">{entry.description}</span>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

// ── Root component ───────────────────────────────────────────────────────────

export default function HubClient() {
    // UI-audit Phase 2: resolve the workspace from client context rather
    // than the env-fallback chain that used to land on a zero-uuid. SWR
    // skips the fetch while `workspaceId` is falsy — the empty-state
    // branch below renders until the context populates.
    const { workspaceId } = useWorkspace()
    const confirmAction = useConfirm()

    const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
    const [pendingAction, setPendingAction] = useState<string | null>(null)
    const initialSelectionMade = useRef(false)

    const lf = useListFilter(FILTER_KEYS, 'default')
    const { search, filterValues, sort } = lf

    // ── Data fetch (SWR, 60s poll) ──────────────────────────────────────────
    const catalogKey = workspaceId
        ? `${API_BASE}/api/v1/hub/catalog?workspaceId=${workspaceId}`
        : null

    const { data, error, isLoading, mutate } = useSWR<{ items: HubItem[] }>(
        catalogKey,
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )

    const items = useMemo(() => data?.items ?? [], [data])

    // ── Filtering ───────────────────────────────────────────────────────────
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        const typeFilter = filterValues.type
        const statusFilter = filterValues.status
        const trustFilter = filterValues.trust
        const categoryFilter = filterValues.category
        const publisherFilter = filterValues.publisher

        return items.filter((item) => {
            if (typeFilter && item.type !== typeFilter) return false
            if (statusFilter) {
                if (statusFilter === 'installed' && item.installStatus !== 'installed') return false
                if (statusFilter === 'not_installed' && item.installStatus !== 'not_installed') return false
                if (statusFilter === 'coming_soon' && item.installStatus !== 'coming_soon') return false
            }
            if (trustFilter && item.trust !== trustFilter) return false
            if (categoryFilter && item.category !== categoryFilter) return false
            if (publisherFilter && item.publisher !== publisherFilter) return false
            if (q) {
                const blob = `${item.name} ${item.displayName} ${item.description} ${(item.tags ?? []).join(' ')} ${item.type}`.toLowerCase()
                if (!blob.includes(q)) return false
            }
            return true
        })
    }, [items, search, filterValues])

    const sorted = useMemo(() => {
        const list = [...filtered]
        const scoreOf = (i: HubItem) => i.score ?? 0
        const engagementOf = (i: HubItem) => (i.upvotes ?? 0) + (i.downvotes ?? 0)

        if (sort === 'name_asc') {
            list.sort((a, b) => a.displayName.localeCompare(b.displayName))
        } else if (sort === 'name_desc') {
            list.sort((a, b) => b.displayName.localeCompare(a.displayName))
        } else if (sort === 'popular') {
            // community engagement = upvotes + downvotes
            list.sort((a, b) => {
                const d = engagementOf(b) - engagementOf(a)
                if (d !== 0) return d
                return a.displayName.localeCompare(b.displayName)
            })
        } else if (sort === 'recent') {
            list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        } else if (sort === 'installs') {
            list.sort((a, b) => b.installCount - a.installCount)
        } else {
            // default: highest scored (score desc, name asc)
            list.sort((a, b) => {
                if (scoreOf(b) !== scoreOf(a)) return scoreOf(b) - scoreOf(a)
                return a.displayName.localeCompare(b.displayName)
            })
        }
        return list
    }, [filtered, sort])

    // ── Initial selection: first installed, else first item ────────────────
    useEffect(() => {
        if (initialSelectionMade.current || isLoading) return
        if (items.length === 0) return
        const firstInstalled = items.find((i) => i.installStatus === 'installed')
        const target = firstInstalled ?? items[0]
        if (target) setSelectedSlug(target.slug)
        initialSelectionMade.current = true
    }, [isLoading, items])

    // ── Filter dimensions ───────────────────────────────────────────────────
    const dimensions: FilterDimension[] = useMemo(() => {
        // Use first occurrences to avoid empty dims blocking filters
        const typeCounts = new Map<string, number>()
        const statusCounts = { installed: 0, not_installed: 0, coming_soon: 0 }
        const trustCounts = { verified: 0, community: 0 }

        // Category and publisher are derived within the currently-selected
        // type scope so the option list shrinks to what's actually browsable
        // after a user picks a type. When no type is selected we fall back
        // to the full set. This keeps the Agents tab's category picker from
        // getting polluted by Tool-only categories and vice versa.
        const typeFilter = filterValues.type
        const inScope = typeFilter ? items.filter((i) => i.type === typeFilter) : items

        const categoryCounts = new Map<string, number>()
        const publisherCounts = new Map<string, number>()

        for (const item of items) {
            typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1)
            if (item.installStatus in statusCounts) {
                statusCounts[item.installStatus as keyof typeof statusCounts]++
            }
            if (item.trust in trustCounts) trustCounts[item.trust]++
        }
        for (const item of inScope) {
            if (item.category) {
                categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1)
            }
            if (item.publisher) {
                publisherCounts.set(item.publisher, (publisherCounts.get(item.publisher) ?? 0) + 1)
            }
        }

        const typeOptions = Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([key]) => ({ value: key, label: metaFor(key).plural }))

        const categoryOptions = Array.from(categoryCounts.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([key]) => ({ value: key, label: categoryLabel(key) }))

        const publisherOptions = Array.from(publisherCounts.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([key]) => ({ value: key, label: publisherLabel(key) }))

        return [
            { key: 'type', label: 'Type', options: typeOptions },
            {
                key: 'status',
                label: 'Status',
                options: [
                    { value: 'installed', label: 'Installed', dimmed: statusCounts.installed === 0 },
                    { value: 'not_installed', label: 'Not installed', dimmed: statusCounts.not_installed === 0 },
                    { value: 'coming_soon', label: 'Coming soon', dimmed: statusCounts.coming_soon === 0 },
                ],
            },
            {
                key: 'trust',
                label: 'Trust',
                options: [
                    { value: 'verified', label: 'Verified', dimmed: trustCounts.verified === 0 },
                    { value: 'community', label: 'Community', dimmed: trustCounts.community === 0 },
                ],
            },
            { key: 'category', label: 'Category', options: categoryOptions },
            { key: 'publisher', label: 'Publisher', options: publisherOptions },
        ]
    }, [items, filterValues.type])

    const selected = useMemo(
        () => sorted.find((i) => i.slug === selectedSlug) ?? items.find((i) => i.slug === selectedSlug) ?? null,
        [sorted, items, selectedSlug],
    )

    // ── Actions ─────────────────────────────────────────────────────────────
    const refresh = useCallback(() => {
        void mutate()
    }, [mutate])

    async function handleInstall(item: HubItem) {
        if (item.installStatus === 'coming_soon') {
            toast.error(`This ${metaFor(item.type).label.toLowerCase()} is not yet available`)
            return
        }
        setPendingAction(`install:${item.slug}`)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, manifest: item.manifest }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(extractErrorMessage(body) || `Install failed (${res.status})`)
            }
            toast.success(`${metaFor(item.type).label} installed: ${item.displayName}`)
            await mutate()
        } catch (err) {
            toast.error(extractErrorMessage(err))
        } finally {
            setPendingAction(null)
        }
    }

    async function handleToggleEnabled(item: HubItem) {
        if (!item.installedExtensionId) return
        const next = !item.enabled
        setPendingAction(`toggle:${item.slug}`)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions/${item.installedExtensionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, enabled: next }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(extractErrorMessage(body) || `Update failed (${res.status})`)
            }
            toast.success(next ? 'Enabled' : 'Disabled')
            await mutate()
        } catch (err) {
            toast.error(extractErrorMessage(err))
        } finally {
            setPendingAction(null)
        }
    }

    async function handleVote(item: HubItem, direction: 'up' | 'down') {
        // Toggle: if user clicked their current vote, clear it.
        const current = item.userVote ?? null
        const next: 'up' | 'down' | null = current === direction ? null : direction

        // Optimistic update — patch SWR cache in place.
        await mutate(
            (cur) => {
                if (!cur) return cur
                return {
                    ...cur,
                    items: cur.items.map((it) => {
                        if (it.slug !== item.slug) return it
                        let upvotes = it.upvotes ?? 0
                        let downvotes = it.downvotes ?? 0
                        if (current === 'up') upvotes = Math.max(0, upvotes - 1)
                        if (current === 'down') downvotes = Math.max(0, downvotes - 1)
                        if (next === 'up') upvotes += 1
                        if (next === 'down') downvotes += 1
                        return {
                            ...it,
                            upvotes,
                            downvotes,
                            score: upvotes - downvotes,
                            userVote: next,
                        }
                    }),
                }
            },
            { revalidate: false },
        )

        try {
            const res = await fetch(
                `${API_BASE}/api/v1/hub/extensions/${encodeURIComponent(item.slug)}/vote`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ voteType: next }),
                },
            )
            if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(extractErrorMessage(body) || `Vote failed (${res.status})`)
            }
            const summary = (await res.json()) as {
                upvotes: number
                downvotes: number
                score: number
                userVote: 'up' | 'down' | null
            }
            // Re-sync with authoritative server counts without a full refetch.
            await mutate(
                (cur) => {
                    if (!cur) return cur
                    return {
                        ...cur,
                        items: cur.items.map((it) =>
                            it.slug === item.slug
                                ? {
                                      ...it,
                                      upvotes: summary.upvotes,
                                      downvotes: summary.downvotes,
                                      score: summary.score,
                                      userVote: summary.userVote,
                                  }
                                : it,
                        ),
                    }
                },
                { revalidate: false },
            )
        } catch (err) {
            toast.error(extractErrorMessage(err))
            // Rollback by revalidating from server.
            await mutate()
        }
    }

    async function handleUninstall(item: HubItem) {
        if (!item.installedExtensionId) return
        if (!await confirmAction({ title: `Uninstall ${metaFor(item.type).label.toLowerCase()}`, description: `Uninstall ${item.displayName}? Any capabilities it provides will stop working.`, confirmLabel: 'Uninstall', variant: 'danger' })) return
        setPendingAction(`uninstall:${item.slug}`)
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/extensions/${item.installedExtensionId}?workspaceId=${workspaceId}`,
                { method: 'DELETE' },
            )
            if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(extractErrorMessage(body) || `Uninstall failed (${res.status})`)
            }
            toast.success(`${metaFor(item.type).label} uninstalled: ${item.displayName}`)
            await mutate()
        } catch (err) {
            toast.error(extractErrorMessage(err))
        } finally {
            setPendingAction(null)
        }
    }

    // ── List item rendering ─────────────────────────────────────────────────
    function renderListItem(item: HubItem): React.ReactNode {
        const meta = metaFor(item.type)
        const Icon = meta.icon
        const score = item.score ?? 0

        return (
            <div className="flex items-center gap-2.5">
                <div className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${meta.iconBg}`}>
                    <Icon className={`h-4 w-4 ${meta.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-text-primary">{item.displayName}</span>
                        {item.trust === 'verified' && (
                            <ShieldCheck className="h-3 w-3 shrink-0 text-azure" />
                        )}
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.badge}`}>
                            {meta.label}
                        </span>
                        <ScoreBadge score={score} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <StatusDot status={item.installStatus} />
                        <span className="text-[11px] text-text-muted truncate">
                            {item.installStatus === 'installed'
                                ? (item.enabled ? 'Enabled' : 'Installed')
                                : item.installStatus === 'coming_soon'
                                    ? 'Coming soon'
                                    : `${item.installCount.toLocaleString()} installs`}
                        </span>
                    </div>
                    {item.sourceRepo && <AttributionInline item={item} />}
                </div>
                <VoteControls
                    upvotes={item.upvotes ?? 0}
                    downvotes={item.downvotes ?? 0}
                    userVote={item.userVote ?? null}
                    size="sm"
                    onVote={(dir, e) => {
                        e.stopPropagation()
                        void handleVote(item, dir)
                    }}
                />
            </div>
        )
    }

    // ── Detail pane ─────────────────────────────────────────────────────────
    const detail = selected ? (
        <DetailPane
            item={selected}
            pendingAction={pendingAction}
            onInstall={() => void handleInstall(selected)}
            onToggleEnabled={() => void handleToggleEnabled(selected)}
            onUninstall={() => void handleUninstall(selected)}
            onVote={(dir) => void handleVote(selected, dir)}
        />
    ) : null

    const emptyDetail = (
        <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center">
                <Package className="h-6 w-6 text-text-muted mx-auto mb-2" />
                <p className="text-sm text-text-muted">Select an extension to view details</p>
            </div>
        </div>
    )

    const errorBanner = error ? (
        <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-red-300">
                <AlertCircle className="h-4 w-4" />
                <span>Couldn&apos;t load the hub. {extractErrorMessage(error)}</span>
            </div>
            <button
                onClick={refresh}
                className="rounded-md border border-red-800/50 bg-red-900/20 px-3 py-1 text-xs text-red-200 hover:bg-red-900/40"
            >
                Retry
            </button>
        </div>
    ) : null

    const headerActions = (
        <>
            <button
                onClick={refresh}
                disabled={isLoading}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-40"
                title="Refresh catalog"
            >
                <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
            </button>
            <a
                href="https://hub.getplexo.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors"
            >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Hub
            </a>
        </>
    )

    // No workspace selected yet — render an empty-state instead of
    // silently firing the Hub fetch against a zero-uuid (pre-Phase-2
    // behavior). Workspace context populates once the sidebar switcher
    // resolves the user's active workspace.
    if (!workspaceId) {
        return (
            <div className="flex h-full items-center justify-center p-8">
                <div className="text-center max-w-sm">
                    <Package className="h-8 w-8 text-text-muted mx-auto mb-3" />
                    <h2 className="text-sm font-medium text-text-primary mb-1">Pick a workspace to browse the Hub</h2>
                    <p className="text-xs text-text-muted">
                        The Hub catalog is scoped to a workspace so install status and voting stay per-workspace.
                        Select a workspace from the sidebar switcher to continue.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <ConfigListLayout
            title="Hub"
            subtitle="Discover and install extensions for your workspace"
            headerActions={headerActions}
            bannerSlot={<TaxonomyExplainer />}
            filterHook={lf}
            searchPlaceholder="Search extensions…"
            filterDimensions={dimensions}
            sortOptions={[
                { label: 'Highest scored', value: 'default' },
                { label: 'Newest', value: 'recent' },
                { label: 'Most popular', value: 'popular' },
                { label: 'Most installs', value: 'installs' },
                { label: 'Name (A-Z)', value: 'name_asc' },
                { label: 'Name (Z-A)', value: 'name_desc' },
            ]}
            items={sorted}
            loading={isLoading && items.length === 0}
            emptyMessage={items.length === 0 ? 'Loading hub…' : 'No extensions match your filters'}
            getItemKey={(i) => i.slug}
            isSelected={(i) => i.slug === selectedSlug}
            onSelect={(i) => setSelectedSlug(i.slug)}
            renderListItem={(i) => renderListItem(i)}
            listWidthClass="md:w-[380px]"
            detail={detail}
            emptyDetail={emptyDetail}
            errorBanner={errorBanner}
        />
    )
}

// ── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: HubItem['installStatus'] }) {
    if (status === 'installed') {
        return <span className="h-1.5 w-1.5 rounded-full bg-green-400 shrink-0" aria-label="Installed" />
    }
    if (status === 'coming_soon') {
        return <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-label="Coming soon" />
    }
    if (status === 'incompatible') {
        return <span className="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" aria-label="Incompatible" />
    }
    return <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40 shrink-0" aria-label="Not installed" />
}

// ── Detail pane ─────────────────────────────────────────────────────────────

function DetailPane({
    item,
    pendingAction,
    onInstall,
    onToggleEnabled,
    onUninstall,
    onVote,
}: {
    item: HubItem
    pendingAction: string | null
    onInstall: () => void
    onToggleEnabled: () => void
    onUninstall: () => void
    onVote: (direction: 'up' | 'down') => void
}) {
    const meta = metaFor(item.type)
    const Icon = meta.icon
    const manifest = item.manifest ?? {}

    const capabilities = manifestArr(manifest, 'capabilities')
    const tags = item.tags ?? []
    const toolNames = manifestToolNames(manifest)
    const requires = (() => {
        const r = manifest.requires
        if (!r || typeof r !== 'object') return null
        return r as Record<string, unknown>
    })()

    const hubUrl = `https://hub.getplexo.com/ext/${encodeURIComponent(item.slug)}`

    const installing = pendingAction === `install:${item.slug}`
    const toggling = pendingAction === `toggle:${item.slug}`
    const uninstalling = pendingAction === `uninstall:${item.slug}`

    return (
        <div className="flex-1 overflow-y-auto">
            {/* Header */}
            <div className="p-5 border-b border-border/60">
                <div className="flex items-start gap-4">
                    <div className={`h-12 w-12 shrink-0 rounded-xl flex items-center justify-center ${meta.iconBg}`}>
                        <Icon className={`h-6 w-6 ${meta.iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-lg font-semibold text-text-primary truncate">{item.displayName}</h2>
                            <ScoreBadge score={item.score ?? 0} />
                            <span title={meta.tooltip} className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.badge}`}>
                                {meta.label}
                            </span>
                            {item.trust === 'verified' && (
                                <span className="flex items-center gap-1 rounded-full border border-azure/30 bg-azure/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-azure">
                                    <ShieldCheck className="h-3 w-3" />
                                    Verified
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-xs font-mono text-text-muted">
                            {item.name} · v{item.version}
                        </p>
                        <p className="mt-0.5 text-xs text-text-muted">
                            by {item.publisher} · {item.installCount.toLocaleString()} installs
                        </p>
                    </div>
                </div>

                {/* Status + primary action */}
                <div className="mt-4 flex items-center gap-2 flex-wrap">
                    {item.installStatus === 'installed' ? (
                        <>
                            <span className="flex items-center gap-1.5 rounded-lg border border-green-600/30 bg-green-900/20 px-2.5 py-1 text-xs font-medium text-green-300">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                {item.enabled ? 'Enabled' : 'Installed (disabled)'}
                            </span>
                            <button
                                onClick={onToggleEnabled}
                                disabled={toggling}
                                className="rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-40"
                            >
                                {toggling
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" />
                                    : (item.enabled ? 'Disable' : 'Enable')}
                            </button>
                            <button
                                onClick={onUninstall}
                                disabled={uninstalling}
                                className="rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-red-800 hover:text-red-300 transition-colors disabled:opacity-40"
                            >
                                {uninstalling
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" />
                                    : 'Uninstall'}
                            </button>
                        </>
                    ) : item.installStatus === 'coming_soon' ? (
                        <span className="flex items-center gap-1.5 rounded-lg border border-amber-600/30 bg-amber-900/20 px-2.5 py-1 text-xs font-medium text-amber-300">
                            <Clock className="h-3.5 w-3.5" />
                            Coming soon
                        </span>
                    ) : (
                        <button
                            onClick={onInstall}
                            disabled={installing}
                            className="flex items-center gap-1.5 rounded-lg border border-azure/50 bg-azure/15 px-3 py-1.5 text-xs font-semibold text-azure hover:bg-azure/25 transition-colors disabled:opacity-40"
                        >
                            {installing
                                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing…</>
                                : <><Download className="h-3.5 w-3.5" /> Install</>}
                        </button>
                    )}
                    <a
                        href={hubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Details
                    </a>
                </div>
            </div>

            {/* Body */}
            <div className="p-5 space-y-5">
                {/* Community score + vote controls */}
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Community</h3>
                    <VoteControls
                        upvotes={item.upvotes ?? 0}
                        downvotes={item.downvotes ?? 0}
                        userVote={item.userVote ?? null}
                        size="md"
                        onVote={(dir, e) => {
                            e.stopPropagation()
                            onVote(dir)
                        }}
                    />
                </section>

                {/* Description */}
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">About</h3>
                    <p className="text-sm text-text-secondary whitespace-pre-wrap">{item.description || 'No description.'}</p>
                </section>

                {/* Attribution — imported third-party items */}
                {item.sourceRepo && (
                    <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Attribution</h3>
                        <AttributionBlock item={item} />
                    </section>
                )}

                {/* Capabilities */}
                {capabilities.length > 0 && (
                    <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Capabilities</h3>
                        <div className="flex flex-wrap gap-1.5">
                            {capabilities.map((c) => (
                                <span key={c} className="rounded-md border border-border bg-surface-1 px-2 py-0.5 text-[11px] font-mono text-text-secondary">
                                    {c}
                                </span>
                            ))}
                        </div>
                    </section>
                )}

                {/* Tools provided */}
                {toolNames.length > 0 && (
                    <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Tools provided</h3>
                        <ul className="space-y-1">
                            {toolNames.map((name) => (
                                <li key={name} className="flex items-center gap-2 text-xs text-text-secondary">
                                    <Wrench className="h-3 w-3 text-text-muted" />
                                    <span className="font-mono">{name}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {/* Required context / model */}
                {requires && Object.keys(requires).length > 0 && (
                    <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Requires</h3>
                        <div className="rounded-md border border-border bg-surface-1/40 p-3">
                            <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap">
                                {JSON.stringify(requires, null, 2)}
                            </pre>
                        </div>
                    </section>
                )}

                {/* Tags */}
                {tags.length > 0 && (
                    <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1.5">Tags</h3>
                        <div className="flex flex-wrap gap-1.5">
                            {tags.map((t) => (
                                <span key={t} className="rounded-full border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-text-muted">
                                    #{t}
                                </span>
                            ))}
                        </div>
                    </section>
                )}

                {/* Coming soon helper copy */}
                {item.installStatus === 'coming_soon' && (
                    <section className="rounded-lg border border-amber-600/30 bg-amber-900/10 p-3">
                        <p className="text-xs text-amber-200 flex items-start gap-2">
                            <Circle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>
                                This extension is published but not yet executable. It will become installable once the publisher
                                ships a runnable entry point.
                            </span>
                        </p>
                    </section>
                )}
            </div>
        </div>
    )
}

// ── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
    const color =
        score > 0 ? 'text-emerald-500' : score < 0 ? 'text-rose-500' : 'text-text-muted'
    const label = score > 0 ? `+${score}` : `${score}`
    return (
        <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-mono font-semibold tabular-nums ${color}`}
            title={`Community score: ${label}`}
        >
            {label}
        </span>
    )
}

// ── Vote controls (up/down thumbs with counts) ──────────────────────────────

interface VoteControlsProps {
    upvotes: number
    downvotes: number
    userVote: 'up' | 'down' | null
    size: 'sm' | 'md'
    onVote: (direction: 'up' | 'down', e: React.MouseEvent) => void
}

function VoteControls({ upvotes, downvotes, userVote, size, onVote }: VoteControlsProps) {
    const icon = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
    const pad = size === 'sm' ? 'px-1.5 py-1' : 'px-2 py-1.5'
    const text = size === 'sm' ? 'text-[10px]' : 'text-xs'

    return (
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
                type="button"
                onClick={(e) => onVote('up', e)}
                aria-label={userVote === 'up' ? 'Remove upvote' : 'Upvote'}
                title={userVote === 'up' ? 'Remove your upvote' : 'Upvote'}
                className={`inline-flex items-center gap-1 rounded-md border ${pad} ${text} tabular-nums transition-colors ${
                    userVote === 'up'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500'
                        : 'border-border bg-surface-1 text-text-muted hover:text-text-primary hover:border-border'
                }`}
            >
                <ThumbsUp className={icon} />
                <span>{upvotes}</span>
            </button>
            <button
                type="button"
                onClick={(e) => onVote('down', e)}
                aria-label={userVote === 'down' ? 'Remove downvote' : 'Downvote'}
                title={userVote === 'down' ? 'Remove your downvote' : 'Downvote'}
                className={`inline-flex items-center gap-1 rounded-md border ${pad} ${text} tabular-nums transition-colors ${
                    userVote === 'down'
                        ? 'border-rose-500/50 bg-rose-500/10 text-rose-500'
                        : 'border-border bg-surface-1 text-text-muted hover:text-text-primary hover:border-border'
                }`}
            >
                <ThumbsDown className={icon} />
                <span>{downvotes}</span>
            </button>
        </div>
    )
}

// ── Attribution ─────────────────────────────────────────────────────────────

function repoHost(url: string | null | undefined): string {
    if (!url) return 'source'
    try {
        const u = new URL(url)
        return u.hostname.replace(/^www\./, '')
    } catch {
        return 'source'
    }
}

function AttributionInline({ item }: { item: HubItem }) {
    const href = item.sourceUrl || item.sourceRepo || undefined
    const host = repoHost(item.sourceRepo || item.sourceUrl || undefined)
    const author = item.sourceAuthor
    return (
        <div
            className="mt-0.5 flex items-center gap-1 text-[10px] text-text-muted truncate"
            onClick={(e) => e.stopPropagation()}
            title={item.sourceLicense ? `License: ${item.sourceLicense}` : undefined}
        >
            <span className="truncate">
                via {author ?? 'upstream'} on {host}
            </span>
            {href && (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-text-muted hover:text-text-primary"
                    aria-label="Open source file"
                >
                    <ExternalLink className="h-2.5 w-2.5" />
                </a>
            )}
        </div>
    )
}

function AttributionBlock({ item }: { item: HubItem }) {
    const author = item.sourceAuthor ?? 'upstream author'
    const host = repoHost(item.sourceRepo || item.sourceUrl || undefined)
    return (
        <div className="rounded-lg border border-border bg-surface-1/40 p-3 space-y-2">
            <p className="text-xs text-text-secondary">
                Imported from <span className="font-medium text-text-primary">{author}</span> on {host}.
            </p>
            <div className="flex flex-wrap gap-2">
                {item.sourceUrl && (
                    <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:border-border"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Source file
                    </a>
                )}
                {item.sourceRepo && (
                    <a
                        href={item.sourceRepo}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:border-border"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Repository
                    </a>
                )}
                {item.sourceLicense && (
                    <span
                        className="inline-flex items-center rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-muted"
                        title={`License: ${item.sourceLicense}`}
                    >
                        License: {item.sourceLicense}
                    </span>
                )}
            </div>
        </div>
    )
}
