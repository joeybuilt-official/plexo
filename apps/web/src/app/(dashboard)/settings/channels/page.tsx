// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    MessageSquare,
    Send,
    Hash,
    Webhook,
    RefreshCw,
    Plus,
    Trash2,
    ToggleLeft,
    ToggleRight,
    AlertCircle,
    CheckCircle2,
    Clock,
    ChevronRight,
    Copy,
    Globe,
    Link2,
    Puzzle,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const FILTER_KEYS = ['type', 'status'] as const

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

/** Channel type → connections registry ID (for cross-referencing) */
const CHANNEL_TO_REGISTRY: Record<string, string> = {
    telegram: 'telegram',
    slack: 'slack',
    discord: 'discord',
}

interface InstalledSummary {
    id: string
    registryId: string
    name: string
    status: string
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ChannelType = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix'

interface Channel {
    id: string
    type: ChannelType
    name: string
    enabled: boolean
    errorCount: number
    lastMessageAt: string | null
    createdAt: string
    config: Record<string, unknown>
}

// ── Channel type display config ────────────────────────────────────────────────

const CHANNEL_META: Record<ChannelType, { label: string; icon: React.ElementType; color: string; docFields: string[] }> = {
    telegram: { label: 'Telegram', icon: Send, color: 'text-sky-400', docFields: ['bot_token', 'webhook_secret'] },
    slack: { label: 'Slack', icon: Hash, color: 'text-emerald', docFields: ['bot_token', 'signing_secret', 'app_token'] },
    discord: { label: 'Discord', icon: MessageSquare, color: 'text-indigo', docFields: ['application_id', 'public_key', 'bot_token'] },
    whatsapp: { label: 'WhatsApp', icon: MessageSquare, color: 'text-green-400', docFields: ['phone_number_id', 'access_token', 'verify_token'] },
    signal: { label: 'Signal', icon: Send, color: 'text-blue-400', docFields: ['phone_number'] },
    matrix: { label: 'Matrix', icon: Hash, color: 'text-purple-400', docFields: ['homeserver', 'access_token', 'user_id'] },
}

const AVAILABLE_TYPES: ChannelType[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix']

// ── Add channel modal state ───────────────────────────────────────────────────

interface AddState {
    type: ChannelType
    name: string
    fields: Record<string, string>
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

// ── Telegram Wizard ──────────────────────────────────────────────────────────

function TelegramWizard({
    fields,
    onChange,
}: {
    fields: Record<string, string>
    onChange: (k: string, v: string) => void
}) {
    const [step, setStep] = useState(0)
    const [verifying, setVerifying] = useState(false)
    const [verifyResult, setVerifyResult] = useState<{ ok: boolean; botName?: string } | null>(null)

    async function verifyToken() {
        const token = fields.bot_token?.trim()
        if (!token) return
        setVerifying(true)
        setVerifyResult(null)
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
            const data = await res.json() as { ok: boolean; result?: { username: string; first_name: string } }
            setVerifyResult({ ok: data.ok, botName: data.result ? `${data.result.first_name} (@${data.result.username})` : undefined })
            if (data.ok) setStep(2)
        } catch {
            setVerifyResult({ ok: false })
        } finally {
            setVerifying(false)
        }
    }

    const STEPS = [
        {
            label: 'Create bot',
            content: (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-text-secondary">Use <strong className="text-text-primary">@BotFather</strong> on Telegram to create a new bot and get its token.</p>
                    <ol className="flex flex-col gap-2 text-sm text-text-muted list-decimal list-inside">
                        <li>Open Telegram → search <code className="text-sky-400">@BotFather</code></li>
                        <li>Send <code className="text-sky-400">/newbot</code></li>
                        <li>Follow prompts — choose a name and username ending in <code className="text-text-secondary">bot</code></li>
                        <li>Copy the token BotFather gives you</li>
                    </ol>
                    <a
                        href="https://t.me/botfather"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:text-sky-300 transition-colors"
                    >
                        Open @BotFather ↗
                    </a>
                    <button
                        onClick={() => setStep(1)}
                        className="self-start rounded-lg bg-indigo px-4 py-2 text-sm font-medium text-text-primary hover:bg-indigo/90 transition-colors"
                    >
                        I have my token →
                    </button>
                </div>
            ),
        },
        {
            label: 'Paste token',
            content: (
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">Bot token</label>
                        <input
                            type="password"
                            value={fields.bot_token ?? ''}
                            onChange={(e) => onChange('bot_token', e.target.value)}
                            placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none font-mono"
                            autoComplete="new-password"
                        />
                    </div>
                    {verifyResult && (
                        <div className={`rounded-lg border px-3 py-2 text-sm ${verifyResult.ok ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald' : 'border-red-800/50 bg-red-950/20 text-red'}`}>
                            {verifyResult.ok ? `✓ ${verifyResult.botName ?? 'Bot verified'}` : '✗ Invalid token — check and try again'}
                        </div>
                    )}
                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            onClick={() => void verifyToken()}
                            disabled={verifying || !fields.bot_token?.trim()}
                            className="rounded-lg bg-indigo px-4 py-2 text-sm font-medium text-text-primary hover:bg-indigo/90 disabled:opacity-50 transition-colors flex flex-1 sm:flex-initial items-center justify-center min-h-[44px]"
                        >
                            {verifying ? 'Verifying…' : 'Verify token'}
                        </button>
                        <button onClick={() => setStep(0)} className="text-sm text-text-muted hover:text-text-secondary transition-colors flex flex-1 sm:flex-initial items-center justify-center min-h-[44px] py-2">
                            ← Back
                        </button>
                    </div>
                </div>
            ),
        },
        {
            label: 'Webhook',
            content: (
                <div className="flex flex-col gap-4">
                    {verifyResult?.ok && (
                        <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald">
                            ✓ {verifyResult.botName} connected
                        </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">Webhook secret <span className="text-text-muted font-normal">(optional)</span></label>
                        <input
                            type="password"
                            value={fields.webhook_secret ?? ''}
                            onChange={(e) => onChange('webhook_secret', e.target.value)}
                            placeholder="Random secret for verifying webhook authenticity"
                            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none font-mono"
                            autoComplete="new-password"
                        />
                        <p className="text-xs text-text-muted">Leave blank to auto-generate one. Plexo will register the webhook automatically on save.</p>
                    </div>
                </div>
            ),
        },
    ]

    return (
        <div className="flex flex-col gap-4">
            {/* Step indicator */}
            <div className="flex items-center gap-2">
                {STEPS.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                        <button
                            onClick={() => i < step && setStep(i)}
                            className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors ${i === step ? 'bg-indigo text-text-primary' : i < step ? 'bg-emerald-600/30 text-emerald cursor-pointer' : 'bg-surface-2 text-text-muted'
                                }`}
                        >
                            {i < step ? '✓' : i + 1}
                        </button>
                        <span className={`text-xs ${i === step ? 'text-text-secondary' : 'text-text-muted'}`}>{s.label}</span>
                        {i < STEPS.length - 1 && <span className="h-px w-4 bg-surface-2" />}
                    </div>
                ))}
            </div>
            {STEPS[step]?.content}
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [channels, setChannels] = useState<Channel[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Channel | null>(null)
    const [adding, setAdding] = useState(false)
    const [addState, setAddState] = useState<AddState>({
        type: 'telegram',
        name: '',
        fields: {},
    })
    const [saving, setSaving] = useState(false)
    const [toggling, setToggling] = useState<string | null>(null)
    const [deleting, setDeleting] = useState<string | null>(null)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [installedConnections, setInstalledConnections] = useState<InstalledSummary[]>([])

    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, clearAll } = lf

    const fetchChannels = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const [chRes, instRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/channels?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/connections/installed?workspaceId=${WS_ID}`),
            ])
            if (chRes.ok) {
                const data = await chRes.json() as { items: Channel[] }
                setChannels(data.items ?? [])
            }
            if (instRes.ok) {
                const data = await instRes.json() as { items: InstalledSummary[] }
                setInstalledConnections(data.items ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchChannels() }, [fetchChannels])

    // Reset add form when type changes
    useEffect(() => {
        setAddState((s) => ({ ...s, name: s.name, fields: {} }))
    }, [addState.type])

    async function handleToggle(ch: Channel) {
        setToggling(ch.id)
        try {
            await fetch(`${API_BASE}/api/v1/channels/${ch.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, enabled: !ch.enabled }),
            })
            setChannels((prev) => prev.map((c) => c.id === ch.id ? { ...c, enabled: !c.enabled } : c))
            if (selected?.id === ch.id) setSelected((s) => s ? { ...s, enabled: !s.enabled } : s)
        } finally {
            setToggling(null)
        }
    }

    async function handleDelete(id: string) {
        setDeleting(id)
        try {
            await fetch(`${API_BASE}/api/v1/channels/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
            setChannels((prev) => prev.filter((c) => c.id !== id))
            if (selected?.id === id) setSelected(null)
        } finally {
            setDeleting(null)
        }
    }

    async function handleAdd() {
        if (!addState.name.trim()) return
        setSaving(true)
        setMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    type: addState.type,
                    name: addState.name,
                    config: addState.fields,
                }),
            })
            if (res.ok) {
                setMessage({ ok: true, text: `${addState.name} added` })
                setAdding(false)
                void fetchChannels()
            } else {
                const err = await res.json() as { error?: { message?: string } }
                setMessage({ ok: false, text: err.error?.message ?? 'Failed' })
            }
        } finally {
            setSaving(false)
        }
    }

    const availableTypes = useMemo(() => new Set(channels.map((c) => c.type)), [channels])

    const displayed = useMemo(() => {
        let res = channels
        const q = search.trim().toLowerCase()
        if (filterValues.type) {
            res = res.filter((c) => c.type === filterValues.type)
        }
        if (filterValues.status) {
            if (filterValues.status === 'active') res = res.filter((c) => c.enabled)
            else if (filterValues.status === 'disabled') res = res.filter((c) => !c.enabled)
            else if (filterValues.status === 'error') res = res.filter((c) => c.errorCount > 0)
        }
        if (q) {
            res = res.filter(
                (c) =>
                    c.name.toLowerCase().includes(q) ||
                    CHANNEL_META[c.type].label.toLowerCase().includes(q)
            )
        }
        res = [...res].sort((a, b) => {
            if (lf.sort === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            if (lf.sort === 'errors') return b.errorCount - a.errorCount
            // newest
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })
        return res
    }, [channels, search, filterValues.type, filterValues.status, lf.sort])

    const dimensions = useMemo(
        (): FilterDimension[] => [
            {
                key: 'status',
                label: 'Status',
                options: [
                    { value: 'active', label: 'Active', dimmed: !channels.some((c) => c.enabled) },
                    { value: 'disabled', label: 'Disabled', dimmed: !channels.some((c) => !c.enabled) },
                    { value: 'error', label: 'Error', dimmed: !channels.some((c) => c.errorCount > 0) },
                ],
            },
            {
                key: 'type',
                label: 'Type',
                options: AVAILABLE_TYPES.map((t) => ({
                    value: t,
                    label: CHANNEL_META[t].label,
                    dimmed: !availableTypes.has(t),
                })),
            },
        ],
        [channels, availableTypes]
    )

    const meta = selected ? CHANNEL_META[selected.type] : null

    return (
        <div className="flex flex-col gap-6 h-full">
            {/* Webchat embed snippet */}
            {WS_ID && (
                <div className="rounded-xl border border-indigo/20 bg-indigo-950/10 p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-indigo" />
                        <h2 className="text-sm font-semibold text-indigo-300">Webchat widget</h2>
                        <span className="ml-auto text-[11px] text-indigo">Paste this snippet into any website to add a chat bubble</span>
                    </div>
                    <div className="relative group">
                        <pre className="rounded-lg bg-canvas border border-border p-3 text-[11px] font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">{`<script src="${API_BASE}/api/v1/chat/widget.js"
        data-workspace="${WS_ID}"
        data-site-name="My Site"
></script>`}</pre>
                        <button
                            onClick={() => void navigator.clipboard.writeText(`<script src="${API_BASE}/api/v1/chat/widget.js" data-workspace="${WS_ID}" data-site-name="My Site"></script>`)}
                            className="absolute top-2 right-2 rounded p-1 bg-surface-2 text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
                            title="Copy"
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            )}
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Channels</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Channel adapters that route messages from external platforms into tasks.
                    </p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                        onClick={() => void fetchChannels()}
                        disabled={loading}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] shrink-0"
                    >
                        <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => { setAdding(true); setSelected(null) }}
                        className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo px-3 py-2 text-sm font-medium text-text-primary hover:bg-indigo/90 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                    >
                        <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                        Add channel
                    </button>
                </div>
            </div>

            {/* ListToolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search channels by name or type…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Most errors', value: 'errors' },
                ]}
            />

            {/* Two-panel */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
                {/* Left — channel list */}
                <div className="w-full md:w-[240px] shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible md:overflow-y-auto pb-4 md:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-text-muted w-full min-w-[200px] md:min-w-0">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : displayed.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-text-muted text-center px-4 w-full min-w-[200px] md:min-w-0">
                            <Webhook className="h-6 w-6 text-zinc-700" />
                            {lf.hasFilters ? 'No channels match your filters' : 'No channels configured'}
                            {lf.hasFilters && (
                                <button
                                    onClick={clearAll}
                                    className="mt-2 text-xs text-indigo hover:text-indigo-300 min-h-[44px] px-4 -mx-4"
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : displayed.map((ch) => {
                        const m = CHANNEL_META[ch.type]
                        const Icon = m.icon
                        const active = selected?.id === ch.id
                        const linkedRegistryId = CHANNEL_TO_REGISTRY[ch.type]
                        const linkedIntegration = linkedRegistryId
                            ? installedConnections.find((i) => i.registryId === linkedRegistryId)
                            : undefined
                        return (
                            <button
                                key={ch.id}
                                onClick={() => { setSelected(ch); setAdding(false) }}
                                className={`text-left rounded-xl border p-3 transition-all min-w-[200px] md:min-w-0 shrink-0 min-h-[44px] ${active
                                    ? 'border-indigo/50 bg-surface-1'
                                    : 'border-border bg-surface-1/40 hover:border-border'
                                    }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Icon className={`h-4 w-4 ${m.color}`} />
                                        <span className="text-sm font-medium text-text-primary truncate max-w-[120px]">{ch.name}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {ch.errorCount > 0 && <AlertCircle className="h-3.5 w-3.5 text-red" />}
                                        {linkedIntegration && (
                                            <span title={`Integration: ${linkedIntegration.name}`}>
                                                <Puzzle className="h-3 w-3 text-violet-400" />
                                            </span>
                                        )}
                                        {ch.enabled
                                            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald" />
                                            : <div className="h-2 w-2 rounded-full bg-surface-3" />
                                        }
                                        {active && <ChevronRight className="h-3.5 w-3.5 text-text-muted" />}
                                    </div>
                                </div>
                                <p className="mt-0.5 text-[11px] text-text-muted pl-6 capitalize">{m.label}</p>
                            </button>
                        )
                    })}
                </div>

                {/* Right — detail / add panel */}
                <div className="flex-1 rounded-xl border border-border bg-surface-1/40 overflow-y-auto">
                    {adding ? (
                        /* Add channel form */
                        <div className="p-5 flex flex-col gap-5">
                            <h2 className="text-sm font-semibold text-text-primary">Add channel</h2>

                            {/* Type selector */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Type</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {AVAILABLE_TYPES.map((t) => {
                                        const m = CHANNEL_META[t]
                                        const Icon = m.icon
                                        return (
                                            <button
                                                key={t}
                                                onClick={() => setAddState((s) => ({ ...s, type: t }))}
                                                className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border p-2.5 transition-all min-h-[44px] ${addState.type === t
                                                    ? 'border-indigo/50 bg-surface-2'
                                                    : 'border-border hover:border-border'
                                                    }`}
                                            >
                                                <Icon className={`h-5 w-5 ${m.color}`} />
                                                <span className="text-xs text-text-secondary">{m.label}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Name */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Name</label>
                                <input
                                    type="text"
                                    value={addState.name}
                                    onChange={(e) => setAddState((s) => ({ ...s, name: e.target.value }))}
                                    placeholder={`My ${CHANNEL_META[addState.type].label} bot`}
                                    className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none"
                                />
                            </div>

                            {/* Config fields — wizard for Telegram, generic for others */}
                            {addState.type === 'telegram' ? (
                                <TelegramWizard
                                    fields={addState.fields}
                                    onChange={(k, v) => setAddState((s) => ({ ...s, fields: { ...s.fields, [k]: v } }))}
                                />
                            ) : (
                                CHANNEL_META[addState.type].docFields.map((field) => (
                                    <div key={field} className="flex flex-col gap-1.5">
                                        <label className="text-sm font-medium text-text-secondary">{field.replace(/_/g, ' ')}</label>
                                        <input
                                            type="password"
                                            value={addState.fields[field] ?? ''}
                                            onChange={(e) => setAddState((s) => ({ ...s, fields: { ...s.fields, [field]: e.target.value } }))}
                                            placeholder={field.includes('token') || field.includes('secret') ? '••••••••' : ''}
                                            autoComplete="new-password"
                                            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none font-mono"
                                        />
                                    </div>
                                ))
                            )}

                            {message && (
                                <div className={`rounded-lg border px-3 py-2 text-sm ${message.ok ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald' : 'border-red-800/50 bg-red-950/30 text-red'}`}>
                                    {message.text}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row gap-2">
                                <button
                                    onClick={() => void handleAdd()}
                                    disabled={saving || !addState.name.trim()}
                                    className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo px-4 py-2 text-sm font-medium text-text-primary hover:bg-indigo/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                                    {saving ? 'Adding…' : 'Add'}
                                </button>
                                <button
                                    onClick={() => { setAdding(false); setMessage(null) }}
                                    className="flex items-center justify-center rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : !selected ? (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                                <Webhook className="mx-auto mb-3 h-8 w-8 text-zinc-700" />
                                <p className="text-sm text-text-muted">Select a channel or add one</p>
                            </div>
                        </div>
                    ) : (
                        /* Channel detail */
                        <div className="p-5 flex flex-col gap-5">
                            {/* Header */}
                            <div className="flex flex-col sm:flex-row sm:items-start justify-between pb-4 border-b border-border gap-4">
                                <div className="flex items-center gap-3">
                                    {meta && <meta.icon className={`h-6 w-6 ${meta.color}`} />}
                                    <div>
                                        <h2 className="text-base font-semibold text-text-primary">{selected.name}</h2>
                                        <p className="text-xs text-text-muted capitalize">{meta?.label} · created {timeAgo(selected.createdAt)}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 w-full sm:w-auto">
                                    <button
                                        onClick={() => void handleToggle(selected)}
                                        disabled={toggling === selected.id}
                                        title={selected.enabled ? 'Disable' : 'Enable'}
                                        className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm sm:text-xs transition-colors hover:border-border min-h-[44px]"
                                    >
                                        {toggling === selected.id
                                            ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin text-text-muted" />
                                            : selected.enabled
                                                ? <ToggleRight className="h-5 w-5 sm:h-4 sm:w-4 text-emerald" />
                                                : <ToggleLeft className="h-5 w-5 sm:h-4 sm:w-4 text-text-muted" />
                                        }
                                        <span className={selected.enabled ? 'text-emerald' : 'text-text-muted'}>
                                            {selected.enabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                    </button>
                                    <button
                                        onClick={() => void handleDelete(selected.id)}
                                        disabled={deleting === selected.id}
                                        className="flex flex-1 sm:flex-initial items-center justify-center gap-1 rounded-lg border border-red-800/50 px-2.5 py-1.5 text-sm sm:text-xs text-red hover:border-red-700 transition-colors min-h-[44px]"
                                    >
                                        {deleting === selected.id
                                            ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" />
                                            : <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                                        }
                                        Delete
                                    </button>
                                </div>
                            </div>

                            {/* Stats */}
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="rounded-lg bg-surface-1 border border-border p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">Status</p>
                                    <p className={`text-sm font-semibold ${selected.enabled ? 'text-emerald' : 'text-text-muted'}`}>
                                        {selected.enabled ? 'Active' : 'Disabled'}
                                    </p>
                                </div>
                                <div className="rounded-lg bg-surface-1 border border-border p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">Errors</p>
                                    <p className={`text-sm font-semibold ${selected.errorCount > 0 ? 'text-red' : 'text-text-secondary'}`}>
                                        {selected.errorCount}
                                    </p>
                                </div>
                                <div className="rounded-lg bg-surface-1 border border-border p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1">Last message</p>
                                    <p className="text-sm font-semibold text-text-secondary flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {selected.lastMessageAt ? timeAgo(selected.lastMessageAt) : 'Never'}
                                    </p>
                                </div>
                            </div>

                            {/* Config keys (masked) */}
                            {Object.keys(selected.config).length > 0 && (
                                <div className="rounded-xl border border-border bg-surface-1/40 p-4">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">Configuration</h3>
                                    <div className="flex flex-col gap-2">
                                        {Object.keys(selected.config).map((k) => (
                                            <div key={k} className="flex items-center justify-between text-sm">
                                                <span className="text-text-muted">{k.replace(/_/g, ' ')}</span>
                                                <span className="font-mono text-zinc-700 text-xs">••••••••</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Integration cross-reference */}
                            {(() => {
                                const linkedRegistryId = CHANNEL_TO_REGISTRY[selected.type]
                                const linkedIntegration = linkedRegistryId
                                    ? installedConnections.find((i) => i.registryId === linkedRegistryId)
                                    : undefined
                                if (!linkedIntegration) return null
                                return (
                                    <div className="rounded-lg border border-violet-800/30 bg-violet-950/20 px-3 py-3 flex flex-col gap-1.5">
                                        <p className="text-xs font-semibold text-violet-400 flex items-center gap-1.5">
                                            <Puzzle className="h-3.5 w-3.5" />
                                            Integration linked
                                        </p>
                                        <p className="text-[11px] text-violet-400/70 leading-relaxed">
                                            This channel shares a service with the <strong className="text-violet-300">{linkedIntegration.name}</strong> integration ({linkedIntegration.status}).
                                            Both use the same platform but serve different roles — the channel routes inbound messages, the integration exposes agent tools.
                                        </p>
                                        <a
                                            href="/settings/connections"
                                            className="flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors mt-0.5"
                                        >
                                            <Link2 className="h-3 w-3" />
                                            Manage in Integrations →
                                        </a>
                                    </div>
                                )
                            })()}

                            {selected.errorCount > 0 && (
                                <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2.5 flex items-center gap-2 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    {selected.errorCount} consecutive error{selected.errorCount !== 1 ? 's' : ''} — check token validity and webhook configuration.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
