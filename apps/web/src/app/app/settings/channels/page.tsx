// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useUnsavedChanges } from '@web/hooks/use-unsaved-changes'
import {
    MessageSquare,
    Send,
    Hash,
    Phone,
    Webhook,
    RefreshCw,
    Plus,
    Trash2,
    ToggleLeft,
    ToggleRight,
    AlertCircle,
    CheckCircle2,
    Clock,
    Copy,
    Globe,
    Link2,
    Puzzle,
    Pencil,
    X,
    Save,
    Eye,
    EyeOff,
} from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { useConfirm } from '@web/components/ui/confirm-dialog'
import { useListFilter } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { ConfigListLayout } from '@web/components/config-list-layout'

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

type ChannelType = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'twilio'

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
    slack: { label: 'Slack', icon: Hash, color: 'text-azure', docFields: ['bot_token', 'signing_secret', 'app_token'] },
    discord: { label: 'Discord', icon: MessageSquare, color: 'text-azure', docFields: ['application_id', 'public_key', 'bot_token'] },
    whatsapp: { label: 'WhatsApp', icon: MessageSquare, color: 'text-green-400', docFields: ['phone_number_id', 'access_token', 'verify_token'] },
    signal: { label: 'Signal', icon: Send, color: 'text-azure', docFields: ['phone_number'] },
    matrix: { label: 'Matrix', icon: Hash, color: 'text-purple-400', docFields: ['homeserver', 'access_token', 'user_id'] },
    twilio: { label: 'SMS (Twilio)', icon: Phone, color: 'text-rose-400', docFields: ['account_sid', 'auth_token', 'phone_number'] },
}

const AVAILABLE_TYPES: ChannelType[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix', 'twilio']

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
                        className="self-start rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors"
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
                            className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                            autoComplete="new-password"
                        />
                    </div>
                    {verifyResult && (
                        <div className={`rounded-sm border px-3 py-2 text-sm ${verifyResult.ok ? 'border-azure/30 bg-azure/20 text-azure' : 'border-red-800/50 bg-red-dim text-red'}`}>
                            {verifyResult.ok ? `✓ ${verifyResult.botName ?? 'Bot verified'}` : '✗ Invalid token — check and try again'}
                        </div>
                    )}
                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            onClick={() => void verifyToken()}
                            disabled={verifying || !fields.bot_token?.trim()}
                            className="rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors flex flex-1 sm:flex-initial items-center justify-center min-h-[44px]"
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
                        <div className="rounded-sm border border-azure/30 bg-azure/20 px-3 py-2 text-sm text-azure">
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
                            className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
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
                            className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors ${i === step ? 'bg-azure text-text-primary' : i < step ? 'bg-azure-600/30 text-azure cursor-pointer' : 'bg-surface-2 text-text-muted'
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

function getPublicUrl(): string {
    if (typeof window !== 'undefined') return window.location.origin
    return ''
}

function validateTwilioFields(fields: Record<string, string>): {
    accountSid: string | null
    authToken: string | null
    phoneNumber: string | null
    valid: boolean
} {
    const sid = (fields.account_sid ?? '').trim()
    const token = (fields.auth_token ?? '').trim()
    const phone = (fields.phone_number ?? '').trim()
    const accountSid = sid.length === 0
        ? null
        : !/^AC[a-zA-Z0-9]{32}$/.test(sid)
            ? 'Account SID must start with AC and be 34 characters total.'
            : null
    const authToken = token.length === 0 ? null : null
    const phoneNumber = phone.length === 0
        ? null
        : !/^\+\d{10,15}$/.test(phone)
            ? 'Phone number must be in E.164 format (e.g. +15551234567).'
            : null
    const valid = sid.length > 0 && token.length > 0 && phone.length > 0
        && accountSid === null && phoneNumber === null
    return { accountSid, authToken, phoneNumber, valid }
}

function TwilioForm({
    fields,
    onChange,
}: {
    fields: Record<string, string>
    onChange: (k: string, v: string) => void
}) {
    const v = validateTwilioFields(fields)
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">Twilio Account SID</label>
                <input
                    type="text"
                    value={fields.account_sid ?? ''}
                    onChange={(e) => onChange('account_sid', e.target.value)}
                    placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                    autoComplete="off"
                    spellCheck={false}
                />
                {v.accountSid
                    ? <p className="text-xs text-red">{v.accountSid}</p>
                    : <p className="text-xs text-text-muted">Find in your Twilio console under Account Info.</p>
                }
            </div>
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">Twilio Auth Token</label>
                <input
                    type="password"
                    value={fields.auth_token ?? ''}
                    onChange={(e) => onChange('auth_token', e.target.value)}
                    placeholder="••••••••••••••••••••••••••••••••"
                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                    autoComplete="new-password"
                />
                <p className="text-xs text-text-muted">Stored encrypted; rotate any time.</p>
            </div>
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">Twilio Phone Number</label>
                <input
                    type="text"
                    value={fields.phone_number ?? ''}
                    onChange={(e) => onChange('phone_number', e.target.value)}
                    placeholder="+15551234567"
                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                    autoComplete="off"
                    spellCheck={false}
                />
                {v.phoneNumber
                    ? <p className="text-xs text-red">{v.phoneNumber}</p>
                    : <p className="text-xs text-text-muted">E.164 format. The number Twilio will send from and that users will text.</p>
                }
            </div>
        </div>
    )
}

function TwilioWebhookSection({ channelId }: { channelId: string }) {
    const [copied, setCopied] = useState(false)
    const url = `${getPublicUrl()}/api/v1/channels/twilio/events/${channelId}`
    async function copy() {
        try {
            await navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // ignore
        }
    }
    return (
        <div className="rounded-sm border border-azure/20 bg-azure/10 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4 text-azure" />
                <h3 className="text-sm font-medium text-azure">Webhook URL — paste this into your Twilio console</h3>
            </div>
            <div className="relative group">
                <pre className="rounded-sm bg-canvas border border-border p-3 text-[11px] font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">{url}</pre>
                <button
                    onClick={() => void copy()}
                    className="absolute top-2 right-2 rounded p-1 bg-surface-2 text-text-muted hover:text-text-primary transition-colors sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    title={copied ? 'Copied' : 'Copy'}
                    aria-label="Copy webhook URL"
                >
                    <Copy className="h-3.5 w-3.5" />
                </button>
            </div>
            {copied && <p className="text-[11px] text-azure">Copied to clipboard.</p>}
            <p className="text-[11px] text-azure/80 leading-relaxed">
                In your Twilio console: Phone Numbers → Active → click your number → Messaging → A Message Comes In → Webhook → paste URL → HTTP POST → Save.
            </p>
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
    const WS_ID = useWorkspaceId()
    const confirmAction = useConfirm()
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
    const [editing, setEditing] = useState(false)
    const [editName, setEditName] = useState('')
    const [editFields, setEditFields] = useState<Record<string, string>>({})
    const [editSaving, setEditSaving] = useState(false)
    const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set())
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [installedConnections, setInstalledConnections] = useState<InstalledSummary[]>([])

    // Dirty when user is mid-edit on a channel or mid-add with fields populated
    const hasDirtyEditFields = Object.values(editFields).some(v => v.trim().length > 0)
    const hasDirtyAddFields = Object.values(addState.fields).some(v => v.trim().length > 0) || addState.name.trim().length > 0
    useUnsavedChanges((editing && hasDirtyEditFields) || (adding && hasDirtyAddFields))

    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues } = lf

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
    }, [WS_ID])

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
        const ch = channels.find(c => c.id === id)
        if (!await confirmAction({ title: 'Delete channel', description: `Delete the "${ch?.name ?? 'this'}" channel? This cannot be undone.`, confirmLabel: 'Delete', variant: 'danger' })) return
        setDeleting(id)
        try {
            await fetch(`${API_BASE}/api/v1/channels/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
            setChannels((prev) => prev.filter((c) => c.id !== id))
            if (selected?.id === id) setSelected(null)
        } finally {
            setDeleting(null)
        }
    }

    function startEditing(ch: Channel) {
        setEditing(true)
        setEditName(ch.name)
        const meta = CHANNEL_META[ch.type]
        const fields: Record<string, string> = {}
        for (const k of meta.docFields) {
            // Populate with empty — user must re-enter secrets (we don't send them back)
            fields[k] = ''
        }
        setEditFields(fields)
        setRevealedFields(new Set())
        setMessage(null)
    }

    function cancelEditing() {
        setEditing(false)
        setMessage(null)
    }

    async function handleEditSave() {
        if (!selected) return
        setEditSaving(true)
        setMessage(null)
        try {
            // Build config: only include fields that were actually filled in
            const config: Record<string, string> = {}
            for (const [k, v] of Object.entries(editFields)) {
                if (v.trim()) config[k] = v.trim()
            }
            // Merge with existing config so blank fields keep old values
            const mergedConfig = { ...(selected.config as Record<string, unknown>), ...config }

            const body: Record<string, unknown> = { workspaceId: WS_ID }
            if (editName.trim() && editName.trim() !== selected.name) body.name = editName.trim()
            if (Object.keys(config).length > 0) body.config = mergedConfig
            // If only name changed and no config, still include config to preserve it
            if (!body.config) body.config = selected.config

            const res = await fetch(`${API_BASE}/api/v1/channels/${selected.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (res.ok) {
                setMessage({ ok: true, text: 'Channel updated' })
                setEditing(false)
                void fetchChannels()
                // Update local selected state
                const updatedName = (body.name as string) ?? selected.name
                const updatedConfig = (body.config as Record<string, unknown>) ?? selected.config
                setSelected((s) => s ? { ...s, name: updatedName, config: updatedConfig } : s)
                setChannels((prev) => prev.map((c) => c.id === selected.id ? { ...c, name: updatedName, config: updatedConfig } : c))
            } else {
                const err = await res.json() as { error?: { message?: string } }
                setMessage({ ok: false, text: err.error?.message ?? 'Update failed' })
            }
        } finally {
            setEditSaving(false)
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

    const dimensions: FilterDimension[] = useMemo(
        () => [
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

    // ── List item renderer ───────────────────────────────────────────────────
    function renderListItem(ch: Channel) {
        const m = CHANNEL_META[ch.type]
        const Icon = m.icon
        const linkedRegistryId = CHANNEL_TO_REGISTRY[ch.type]
        const linkedConnection = linkedRegistryId
            ? installedConnections.find((i) => i.registryId === linkedRegistryId)
            : undefined
        return (
            <div className="flex items-center justify-between gap-2 h-full">
                <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className={`h-5 w-5 shrink-0 ${m.color}`} />
                    <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-text-primary truncate max-w-[140px]">{ch.name}</span>
                        <span className="text-[11px] text-text-muted truncate">{m.label}</span>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {ch.errorCount > 0 && <AlertCircle className="h-3.5 w-3.5 text-red" />}
                    {linkedConnection && (
                        <span title={`Connector: ${linkedConnection.name}`}>
                            <Puzzle className="h-3 w-3 text-violet-400" />
                        </span>
                    )}
                    {ch.enabled
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-azure" />
                        : <div className="h-2 w-2 rounded-full bg-surface-3" />
                    }
                </div>
            </div>
        )
    }

    // ── Header actions ──────────────────────────────────────────────────────
    const headerActions = (
        <>
            <button
                onClick={() => void fetchChannels()}
                disabled={loading}
                className="flex items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors min-w-[44px] min-h-[44px] shrink-0"
                title="Refresh"
                aria-label="Refresh channels"
            >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
                onClick={() => { setAdding(true); setSelected(null) }}
                className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors min-h-[44px]"
            >
                <Plus className="h-4 w-4" />
                Add channel
            </button>
        </>
    )

    // ── Banner slot (webchat embed snippet) ─────────────────────────────────
    const bannerSlot = WS_ID ? (
        <div className="rounded-sm border border-azure/20 bg-azure/10 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-azure" />
                <h2 className="text-sm font-medium text-azure">Webchat widget</h2>
                <span className="ml-auto text-[11px] text-azure">Paste this snippet into any website to add a chat bubble</span>
            </div>
            <div className="relative group">
                <pre className="rounded-sm bg-canvas border border-border p-3 text-[11px] font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap break-all">{`<script src="${API_BASE}/api/v1/chat/widget.js"
        data-workspace="${WS_ID}"
        data-site-name="My Site"
></script>`}</pre>
                <button
                    onClick={() => void navigator.clipboard.writeText(`<script src="${API_BASE}/api/v1/chat/widget.js" data-workspace="${WS_ID}" data-site-name="My Site"></script>`)}
                    className="absolute top-2 right-2 rounded p-1 bg-surface-2 text-text-muted hover:text-text-primary transition-colors sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    title="Copy"
                    aria-label="Copy widget snippet"
                >
                    <Copy className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    ) : null

    // ── Detail pane ─────────────────────────────────────────────────────────
    const detail = adding ? (
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
            <h2 className="text-sm font-medium text-text-primary">Add channel</h2>

            {/* Type selector */}
            <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">Type</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {AVAILABLE_TYPES.map((t) => {
                        const m = CHANNEL_META[t]
                        const Icon = m.icon
                        return (
                            <button
                                key={t}
                                onClick={() => setAddState((s) => ({ ...s, type: t }))}
                                className={`flex flex-col items-center justify-center gap-1.5 rounded-sm border p-2.5 transition-all min-h-[44px] ${addState.type === t
                                    ? 'border-azure/50 bg-surface-2'
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
                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                />
            </div>

            {/* Config fields — wizard for Telegram, dedicated form for Twilio, generic for others */}
            {addState.type === 'telegram' ? (
                <TelegramWizard
                    fields={addState.fields}
                    onChange={(k, v) => setAddState((s) => ({ ...s, fields: { ...s.fields, [k]: v } }))}
                />
            ) : addState.type === 'twilio' ? (
                <TwilioForm
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
                            className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                        />
                    </div>
                ))
            )}

            {message && (
                <div className={`rounded-sm border px-3 py-2 text-sm ${message.ok ? 'border-azure/30 bg-azure/30 text-azure' : 'border-red-800/50 bg-red-dim text-red'}`}>
                    {message.text}
                </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
                <button
                    onClick={() => void handleAdd()}
                    disabled={saving || !addState.name.trim() || (addState.type === 'twilio' && !validateTwilioFields(addState.fields).valid)}
                    className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                >
                    {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                    {saving ? 'Adding…' : 'Add'}
                </button>
                <button
                    onClick={() => { setAdding(false); setMessage(null) }}
                    className="flex items-center justify-center rounded-sm border border-border px-3 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors min-h-[44px] flex-1 sm:flex-initial"
                >
                    Cancel
                </button>
            </div>
        </div>
    ) : selected ? (
        <>
            {/* Detail header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 border-b border-border">
                <div className="flex items-start gap-3">
                    {meta && (
                        <div className="h-10 w-10 rounded-sm bg-surface-2 flex items-center justify-center shrink-0">
                            <meta.icon className={`h-5 w-5 ${meta.color}`} />
                        </div>
                    )}
                    <div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-medium text-text-primary">{selected.name}</h2>
                            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide bg-surface-2/40 text-text-secondary border border-border">
                                {meta?.label}
                            </span>
                            {selected.enabled ? (
                                <span className="inline-flex items-center gap-1 rounded-sm border border-azure/30 bg-azure/10 px-1.5 py-0.5 text-[11px] font-medium text-azure">
                                    <CheckCircle2 className="h-2.5 w-2.5" />
                                    Enabled
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2/30 px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                                    Disabled
                                </span>
                            )}
                        </div>
                        <p className="text-[11px] text-text-muted mt-0.5">Created {timeAgo(selected.createdAt)}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                    <button
                        onClick={() => void handleToggle(selected)}
                        disabled={toggling === selected.id}
                        title={selected.enabled ? 'Disable' : 'Enable'}
                        className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0"
                    >
                        {toggling === selected.id
                            ? <RefreshCw className="h-3 w-3 animate-spin text-text-muted" />
                            : selected.enabled
                                ? <ToggleRight className="h-4 w-4 text-azure" />
                                : <ToggleLeft className="h-4 w-4 text-text-muted" />
                        }
                        {selected.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                        onClick={() => editing ? cancelEditing() : startEditing(selected)}
                        className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors min-h-[44px] sm:min-h-0"
                    >
                        {editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                        {editing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                        onClick={() => void handleDelete(selected.id)}
                        disabled={deleting === selected.id}
                        className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-red hover:border-red-700 hover:bg-red-dim/50 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0"
                    >
                        {deleting === selected.id
                            ? <RefreshCw className="h-3 w-3 animate-spin" />
                            : <Trash2 className="h-3 w-3" />
                        }
                        Delete
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-sm bg-surface-1 border border-border p-3">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">Status</p>
                        <p className={`text-sm font-medium ${selected.enabled ? 'text-azure' : 'text-text-muted'}`}>
                            {selected.enabled ? 'Active' : 'Disabled'}
                        </p>
                    </div>
                    <div className="rounded-sm bg-surface-1 border border-border p-3">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">Errors</p>
                        <p className={`text-sm font-medium ${selected.errorCount > 0 ? 'text-red' : 'text-text-secondary'}`}>
                            {selected.errorCount}
                        </p>
                    </div>
                    <div className="rounded-sm bg-surface-1 border border-border p-3">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">Last message</p>
                        <p className="text-sm font-medium text-text-secondary flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {selected.lastMessageAt ? timeAgo(selected.lastMessageAt) : 'Never'}
                        </p>
                    </div>
                </div>

                {/* Edit form or read-only config */}
                {editing ? (
                    <div className="rounded-sm border border-azure/30 bg-surface-1/40 p-4 flex flex-col gap-4">
                        <h3 className="text-xs font-medium uppercase tracking-wider text-azure">Edit configuration</h3>

                        {/* Channel name */}
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium text-text-secondary">Channel name</label>
                            <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                placeholder="Channel name"
                                className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                            />
                        </div>

                        {/* Config fields */}
                        {CHANNEL_META[selected.type].docFields.map((field) => {
                            const existing = selected.config[field]
                            const hasExisting = existing !== undefined && existing !== ''
                            const lastFour = hasExisting ? String(existing).slice(-4) : ''
                            const revealed = revealedFields.has(field)
                            return (
                                <div key={field} className="flex flex-col gap-1.5">
                                    <label className="text-sm font-medium text-text-secondary">
                                        {field.replace(/_/g, ' ')}
                                        {hasExisting && (
                                            <span className="ml-2 text-[11px] font-normal text-text-muted">
                                                current: ••••{lastFour}
                                            </span>
                                        )}
                                    </label>
                                    <div className="relative">
                                        <input
                                            type={revealed ? 'text' : 'password'}
                                            value={editFields[field] ?? ''}
                                            onChange={(e) => setEditFields((f) => ({ ...f, [field]: e.target.value }))}
                                            placeholder={hasExisting ? 'Leave blank to keep current' : field.includes('token') || field.includes('secret') ? '••••••••' : ''}
                                            autoComplete="new-password"
                                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 pr-9 text-[16px] sm:text-sm min-h-[44px] text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setRevealedFields((s) => {
                                                const next = new Set(s)
                                                if (next.has(field)) next.delete(field)
                                                else next.add(field)
                                                return next
                                            })}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary transition-colors"
                                            title={revealed ? 'Hide' : 'Show'}
                                            aria-label={revealed ? 'Hide field value' : 'Show field value'}
                                        >
                                            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                        </button>
                                    </div>
                                </div>
                            )
                        })}

                        {message && (
                            <div className={`rounded-sm border px-3 py-2 text-sm ${message.ok ? 'border-azure/30 bg-azure/30 text-azure' : 'border-red-800/50 bg-red-dim text-red'}`}>
                                {message.text}
                            </div>
                        )}

                        <div className="flex flex-col sm:flex-row gap-2">
                            <button
                                onClick={() => void handleEditSave()}
                                disabled={editSaving || !editName.trim()}
                                className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                {editSaving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : <Save className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                                {editSaving ? 'Saving…' : 'Save changes'}
                            </button>
                            <button
                                onClick={cancelEditing}
                                className="flex items-center justify-center rounded-sm border border-border px-3 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Config keys (masked) */}
                        {Object.keys(selected.config).length > 0 && (
                            <div className="rounded-sm border border-border bg-surface-1/40 p-4">
                                <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Configuration</h3>
                                <div className="flex flex-col gap-2">
                                    {Object.keys(selected.config).map((k) => (
                                        <div key={k} className="flex items-center justify-between text-sm">
                                            <span className="text-text-muted">{k.replace(/_/g, ' ')}</span>
                                            <span className="font-mono text-text-muted text-xs">••••••••</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}

                {/* Twilio webhook URL */}
                {selected.type === 'twilio' && <TwilioWebhookSection channelId={selected.id} />}

                {/* Connection cross-reference */}
                {(() => {
                    const linkedRegistryId = CHANNEL_TO_REGISTRY[selected.type]
                    const linkedConnection = linkedRegistryId
                        ? installedConnections.find((i) => i.registryId === linkedRegistryId)
                        : undefined
                    if (!linkedConnection) return null
                    return (
                        <div className="rounded-sm border border-violet-800/30 bg-surface-2/20 px-3 py-3 flex flex-col gap-1.5">
                            <p className="text-xs font-medium text-violet-400 flex items-center gap-1.5">
                                <Puzzle className="h-3.5 w-3.5" />
                                Connector linked
                            </p>
                            <p className="text-[11px] text-violet-400/70 leading-relaxed">
                                This channel is linked to the <strong className="text-violet-300">{linkedConnection.name}</strong> connector ({linkedConnection.status}).
                                The connector handles authentication — the channel routes inbound messages to the agent.
                            </p>
                            <a
                                href="/app/settings/connections"
                                className="flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors mt-0.5"
                            >
                                <Link2 className="h-3 w-3" />
                                Manage in Integrations →
                            </a>
                        </div>
                    )
                })()}

                {selected.errorCount > 0 && (
                    <div role="alert" className="rounded-sm border border-red-800/40 bg-red-dim px-3 py-2.5 flex items-center gap-2 text-sm text-red">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        {selected.errorCount} consecutive error{selected.errorCount !== 1 ? 's' : ''} — check token validity and webhook configuration.
                    </div>
                )}
            </div>
        </>
    ) : null

    const emptyDetail = (
        <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
                <Webhook className="mx-auto mb-3 h-8 w-8 text-text-muted" />
                <p className="text-sm text-text-muted">Select a channel or add one</p>
            </div>
        </div>
    )

    return (
        <ConfigListLayout
            title="Channels"
            subtitle="Channel adapters that route messages from external platforms into tasks."
            headerActions={headerActions}
            bannerSlot={bannerSlot}
            filterHook={lf}
            searchPlaceholder="Search channels by name or type…"
            filterDimensions={dimensions}
            sortOptions={[
                { label: 'Newest first', value: 'newest' },
                { label: 'Oldest first', value: 'oldest' },
                { label: 'Most errors', value: 'errors' },
            ]}
            items={displayed}
            loading={loading}
            emptyMessage="No channels configured yet. Click 'Add channel' to connect Telegram, Slack, Discord, or other platforms."
            getItemKey={(ch) => ch.id}
            isSelected={(ch) => selected?.id === ch.id && !adding}
            onSelect={(ch) => { setSelected(ch); setAdding(false); setEditing(false); setMessage(null) }}
            renderListItem={(ch) => renderListItem(ch)}
            listWidthClass="md:w-[280px]"
            detail={detail}
            emptyDetail={emptyDetail}
        />
    )
}
