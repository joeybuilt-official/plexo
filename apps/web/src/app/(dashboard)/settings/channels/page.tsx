'use client'

import { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const WS_ID = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

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
    slack: { label: 'Slack', icon: Hash, color: 'text-emerald-400', docFields: ['bot_token', 'signing_secret', 'app_token'] },
    discord: { label: 'Discord', icon: MessageSquare, color: 'text-indigo-400', docFields: ['application_id', 'public_key', 'bot_token'] },
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
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

    const fetchChannels = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/channels?workspaceId=${WS_ID}`)
            if (res.ok) {
                const data = await res.json() as { items: Channel[] }
                setChannels(data.items ?? [])
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
            await fetch(`${API_BASE}/api/channels/${ch.id}`, {
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
            await fetch(`${API_BASE}/api/channels/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
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
            const res = await fetch(`${API_BASE}/api/channels`, {
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

    const meta = selected ? CHANNEL_META[selected.type] : null

    return (
        <div className="flex flex-col gap-6 h-full">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Channels</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Channel adapters that route messages from external platforms into tasks.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchChannels()}
                        disabled={loading}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => { setAdding(true); setSelected(null) }}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add channel
                    </button>
                </div>
            </div>

            {/* Two-panel */}
            <div className="flex gap-4 flex-1 min-h-0">
                {/* Left — channel list */}
                <div className="w-[240px] shrink-0 flex flex-col gap-1 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-zinc-600">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : channels.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-zinc-600">
                            <Webhook className="h-6 w-6 text-zinc-700" />
                            No channels configured
                        </div>
                    ) : channels.map((ch) => {
                        const m = CHANNEL_META[ch.type]
                        const Icon = m.icon
                        const active = selected?.id === ch.id
                        return (
                            <button
                                key={ch.id}
                                onClick={() => { setSelected(ch); setAdding(false) }}
                                className={`text-left rounded-xl border p-3 transition-all ${active
                                        ? 'border-indigo-500/50 bg-zinc-900'
                                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                                    }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Icon className={`h-4 w-4 ${m.color}`} />
                                        <span className="text-sm font-medium text-zinc-200 truncate max-w-[120px]">{ch.name}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {ch.errorCount > 0 && <AlertCircle className="h-3.5 w-3.5 text-red-400" />}
                                        {ch.enabled
                                            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                            : <div className="h-2 w-2 rounded-full bg-zinc-600" />
                                        }
                                        {active && <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />}
                                    </div>
                                </div>
                                <p className="mt-0.5 text-[11px] text-zinc-600 pl-6 capitalize">{m.label}</p>
                            </button>
                        )
                    })}
                </div>

                {/* Right — detail / add panel */}
                <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-y-auto">
                    {adding ? (
                        /* Add channel form */
                        <div className="p-5 flex flex-col gap-5">
                            <h2 className="text-sm font-semibold text-zinc-200">Add channel</h2>

                            {/* Type selector */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-zinc-300">Type</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {AVAILABLE_TYPES.map((t) => {
                                        const m = CHANNEL_META[t]
                                        const Icon = m.icon
                                        return (
                                            <button
                                                key={t}
                                                onClick={() => setAddState((s) => ({ ...s, type: t }))}
                                                className={`flex flex-col items-center gap-1.5 rounded-lg border p-2.5 transition-all ${addState.type === t
                                                        ? 'border-indigo-500/50 bg-zinc-800'
                                                        : 'border-zinc-800 hover:border-zinc-700'
                                                    }`}
                                            >
                                                <Icon className={`h-5 w-5 ${m.color}`} />
                                                <span className="text-xs text-zinc-400">{m.label}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Name */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-zinc-300">Name</label>
                                <input
                                    type="text"
                                    value={addState.name}
                                    onChange={(e) => setAddState((s) => ({ ...s, name: e.target.value }))}
                                    placeholder={`My ${CHANNEL_META[addState.type].label} bot`}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                />
                            </div>

                            {/* Dynamic config fields */}
                            {CHANNEL_META[addState.type].docFields.map((field) => (
                                <div key={field} className="flex flex-col gap-1.5">
                                    <label className="text-sm font-medium text-zinc-300">{field.replace(/_/g, ' ')}</label>
                                    <input
                                        type="password"
                                        value={addState.fields[field] ?? ''}
                                        onChange={(e) => setAddState((s) => ({ ...s, fields: { ...s.fields, [field]: e.target.value } }))}
                                        placeholder={field.includes('token') || field.includes('secret') ? '••••••••' : ''}
                                        autoComplete="new-password"
                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none font-mono"
                                    />
                                </div>
                            ))}

                            {message && (
                                <div className={`rounded-lg border px-3 py-2 text-sm ${message.ok ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400' : 'border-red-800/50 bg-red-950/30 text-red-400'}`}>
                                    {message.text}
                                </div>
                            )}

                            <div className="flex gap-2">
                                <button
                                    onClick={() => void handleAdd()}
                                    disabled={saving || !addState.name.trim()}
                                    className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                                >
                                    {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                    {saving ? 'Adding…' : 'Add'}
                                </button>
                                <button
                                    onClick={() => { setAdding(false); setMessage(null) }}
                                    className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : !selected ? (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                                <Webhook className="mx-auto mb-3 h-8 w-8 text-zinc-700" />
                                <p className="text-sm text-zinc-500">Select a channel or add one</p>
                            </div>
                        </div>
                    ) : (
                        /* Channel detail */
                        <div className="p-5 flex flex-col gap-5">
                            {/* Header */}
                            <div className="flex items-start justify-between pb-4 border-b border-zinc-800">
                                <div className="flex items-center gap-3">
                                    {meta && <meta.icon className={`h-6 w-6 ${meta.color}`} />}
                                    <div>
                                        <h2 className="text-base font-semibold text-zinc-100">{selected.name}</h2>
                                        <p className="text-xs text-zinc-500 capitalize">{meta?.label} · created {timeAgo(selected.createdAt)}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => void handleToggle(selected)}
                                        disabled={toggling === selected.id}
                                        title={selected.enabled ? 'Disable' : 'Enable'}
                                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs transition-colors hover:border-zinc-700"
                                    >
                                        {toggling === selected.id
                                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                                            : selected.enabled
                                                ? <ToggleRight className="h-4 w-4 text-emerald-400" />
                                                : <ToggleLeft className="h-4 w-4 text-zinc-500" />
                                        }
                                        <span className={selected.enabled ? 'text-emerald-400' : 'text-zinc-500'}>
                                            {selected.enabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                    </button>
                                    <button
                                        onClick={() => void handleDelete(selected.id)}
                                        disabled={deleting === selected.id}
                                        className="flex items-center gap-1 rounded-lg border border-red-800/50 px-2.5 py-1.5 text-xs text-red-400 hover:border-red-700 transition-colors"
                                    >
                                        {deleting === selected.id
                                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                            : <Trash2 className="h-3.5 w-3.5" />
                                        }
                                        Delete
                                    </button>
                                </div>
                            </div>

                            {/* Stats */}
                            <div className="grid grid-cols-3 gap-3">
                                <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">Status</p>
                                    <p className={`text-sm font-semibold ${selected.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                        {selected.enabled ? 'Active' : 'Disabled'}
                                    </p>
                                </div>
                                <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">Errors</p>
                                    <p className={`text-sm font-semibold ${selected.errorCount > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                                        {selected.errorCount}
                                    </p>
                                </div>
                                <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1">Last message</p>
                                    <p className="text-sm font-semibold text-zinc-400 flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {selected.lastMessageAt ? timeAgo(selected.lastMessageAt) : 'Never'}
                                    </p>
                                </div>
                            </div>

                            {/* Config keys (masked) */}
                            {Object.keys(selected.config).length > 0 && (
                                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Configuration</h3>
                                    <div className="flex flex-col gap-2">
                                        {Object.keys(selected.config).map((k) => (
                                            <div key={k} className="flex items-center justify-between text-sm">
                                                <span className="text-zinc-500">{k.replace(/_/g, ' ')}</span>
                                                <span className="font-mono text-zinc-700 text-xs">••••••••</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {selected.errorCount > 0 && (
                                <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2.5 flex items-center gap-2 text-sm text-red-400">
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
