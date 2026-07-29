// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    KeyRound, RefreshCw, Plus, X, Check, AlertCircle, Copy, RotateCw, Trash2, Lock, ShieldCheck,
} from 'lucide-react'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

type KeyStatus = 'active' | 'revoked' | 'expired'

interface ServiceKey {
    id: string
    appId: string
    name: string
    revoked: boolean
    expiresAt: string | null
    lastUsedAt: string | null
    createdAt: string
    createdBy: string | null
    status: KeyStatus
}

interface ListResponse {
    items: ServiceKey[]
    total: number
}

interface IssuedKey {
    id: string
    appId: string
    name: string
    token: string
}

function StatusBadge({ status }: { status: KeyStatus }) {
    const styles: Record<KeyStatus, string> = {
        active: 'border-green-700/50 bg-green-900/20 text-green-400',
        revoked: 'border-red-800/50 bg-red-dim text-red',
        expired: 'border-amber-700/50 bg-amber-dim/30 text-amber',
    }
    return (
        <span className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${styles[status]}`}>
            {status}
        </span>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AppServiceKeysPage() {
    const [keys, setKeys] = useState<ServiceKey[]>([])
    const [loading, setLoading] = useState(true)
    const [forbidden, setForbidden] = useState(false)

    // Selection / form state
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const [draftAppId, setDraftAppId] = useState('')
    const [draftName, setDraftName] = useState('')
    const [draftExpiresDays, setDraftExpiresDays] = useState<string>('')

    // Action state
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Newly-issued raw token dialog
    const [issued, setIssued] = useState<IssuedKey | null>(null)
    const [copied, setCopied] = useState(false)

    // Revoke confirm
    const [revokeTarget, setRevokeTarget] = useState<ServiceKey | null>(null)

    const fetchKeys = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/admin/app-service-keys`, { credentials: 'include' })
            if (res.status === 401 || res.status === 403) {
                setForbidden(true)
                setKeys([])
                return
            }
            if (res.ok) {
                const data = await res.json() as ListResponse
                setKeys(data.items ?? [])
                setForbidden(false)
            } else {
                setError(`Failed to load (${res.status})`)
            }
        } catch {
            setError('Network error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchKeys() }, [fetchKeys])

    function startCreate() {
        setCreating(true)
        setSelectedId(null)
        setDraftAppId('')
        setDraftName('')
        setDraftExpiresDays('')
        setError(null)
    }

    function selectKey(id: string) {
        setCreating(false)
        setSelectedId(id)
        setError(null)
    }

    async function handleCreate() {
        const appId = draftAppId.trim()
        const name = draftName.trim()
        if (!appId || !name) {
            setError('appId and name are required')
            return
        }
        const days = draftExpiresDays.trim() ? Number(draftExpiresDays) : undefined
        if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
            setError('expiresInDays must be a positive number')
            return
        }
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/admin/app-service-keys`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId, name, expiresInDays: days }),
            })
            if (res.ok) {
                const data = await res.json() as IssuedKey
                setIssued(data)
                setCreating(false)
                setDraftAppId('')
                setDraftName('')
                setDraftExpiresDays('')
                await fetchKeys()
            } else {
                const d = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setError(d.error?.message ?? `Create failed (${res.status})`)
            }
        } catch {
            setError('Network error')
        } finally {
            setSaving(false)
        }
    }

    async function handleRotate(id: string) {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/admin/app-service-keys/${encodeURIComponent(id)}/rotate`, {
                method: 'POST',
                credentials: 'include',
            })
            if (res.ok) {
                const data = await res.json() as IssuedKey
                setIssued(data)
                setSelectedId(data.id)
                await fetchKeys()
            } else {
                const d = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setError(d.error?.message ?? `Rotate failed (${res.status})`)
            }
        } catch {
            setError('Network error')
        } finally {
            setSaving(false)
        }
    }

    async function handleRevoke(id: string) {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/admin/app-service-keys/${encodeURIComponent(id)}/revoke`, {
                method: 'POST',
                credentials: 'include',
            })
            if (res.ok) {
                setRevokeTarget(null)
                await fetchKeys()
            } else {
                const d = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setError(d.error?.message ?? `Revoke failed (${res.status})`)
            }
        } catch {
            setError('Network error')
        } finally {
            setSaving(false)
        }
    }

    function closeIssued() {
        setIssued(null)
        setCopied(false)
    }

    async function copyToken() {
        if (!issued) return
        try {
            await navigator.clipboard.writeText(issued.token)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard may be blocked — token is still visible in the dialog */ }
    }

    // Group keys by appId for the list.
    const grouped = useMemo(() => {
        const m = new Map<string, ServiceKey[]>()
        for (const k of keys) {
            const arr = m.get(k.appId) ?? []
            arr.push(k)
            m.set(k.appId, arr)
        }
        return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }, [keys])

    const selected = useMemo(() => keys.find((k) => k.id === selectedId) ?? null, [keys, selectedId])

    if (forbidden) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-sm text-text-muted">
                <Lock className="h-8 w-8" />
                <p>Super-admin access required.</p>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-medium text-text-primary">
                        <KeyRound className="h-6 w-6 text-azure" /> App Service Keys
                    </h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Per-app service keys for backend service-to-service auth. Raw tokens are shown once on creation — store them immediately.
                    </p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                        onClick={startCreate}
                        className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                    >
                        <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> New key
                    </button>
                    <button
                        onClick={() => void fetchKeys()}
                        disabled={loading}
                        aria-label="Refresh keys"
                        className="flex items-center justify-center rounded-sm border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors min-h-[44px] min-w-[44px] shrink-0"
                    >
                        <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {error && !issued && !revokeTarget && (
                <div role="alert" className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 text-sm text-red">
                    <AlertCircle className="h-4 w-4 shrink-0" />{error}
                </div>
            )}

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pb-4 md:pb-0">
                {/* Left — keys grouped by app */}
                <div className="w-full md:w-[320px] shrink-0 flex flex-col gap-3 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-text-muted">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : grouped.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-text-muted text-center px-4">
                            <ShieldCheck className="h-6 w-6 text-text-muted" />
                            No keys yet
                        </div>
                    ) : grouped.map(([appId, items]) => (
                        <div key={appId} className="flex flex-col gap-1">
                            <div className="text-[11px] font-mono uppercase tracking-wider text-text-muted px-1">{appId}</div>
                            {items.map((k) => {
                                const active = !creating && selectedId === k.id
                                return (
                                    <button
                                        key={k.id}
                                        onClick={() => selectKey(k.id)}
                                        className={`text-left rounded-sm border p-3 transition-all w-full min-h-[44px] ${active
                                            ? 'border-azure/50 bg-surface-1'
                                            : 'border-border bg-surface-1/40 hover:border-border'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-medium text-text-primary truncate">{k.name}</span>
                                            <StatusBadge status={k.status} />
                                        </div>
                                        <p className="mt-1 text-[11px] text-text-muted">
                                            {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                                            {k.expiresAt && ` · Expires ${new Date(k.expiresAt).toLocaleDateString()}`}
                                        </p>
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                </div>

                {/* Right — detail / form */}
                <div className="flex-1 rounded-sm border border-border bg-surface-1/40 overflow-y-auto">
                    {creating ? (
                        <div className="p-5 flex flex-col gap-5">
                            <div className="flex items-center justify-between gap-3 pb-4 border-b border-border">
                                <h2 className="text-base font-medium text-text-primary">New key</h2>
                                <button
                                    onClick={() => setCreating(false)}
                                    aria-label="Cancel"
                                    className="text-text-muted hover:text-text-secondary"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="key-app-id" className="text-sm font-medium text-text-secondary">App ID</label>
                                <input
                                    id="key-app-id"
                                    value={draftAppId}
                                    onChange={(e) => setDraftAppId(e.target.value)}
                                    placeholder="e.g. fylo"
                                    className="rounded-sm border border-border bg-canvas px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring min-h-[44px] font-mono"
                                />
                                <p className="text-xs text-text-muted">Must match the app&apos;s registered slug (X-App-Id header).</p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="key-name" className="text-sm font-medium text-text-secondary">Name</label>
                                <input
                                    id="key-name"
                                    value={draftName}
                                    onChange={(e) => setDraftName(e.target.value)}
                                    placeholder="e.g. prod-2026-06"
                                    className="rounded-sm border border-border bg-canvas px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring min-h-[44px]"
                                />
                                <p className="text-xs text-text-muted">Operator-friendly label. Must be unique per app.</p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="key-expires" className="text-sm font-medium text-text-secondary">Expires in (days)</label>
                                <input
                                    id="key-expires"
                                    type="number"
                                    min={1}
                                    value={draftExpiresDays}
                                    onChange={(e) => setDraftExpiresDays(e.target.value)}
                                    placeholder="leave blank for no expiry"
                                    className="rounded-sm border border-border bg-canvas px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring min-h-[44px]"
                                />
                            </div>

                            {error && (
                                <div role="alert" className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0" />{error}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                                <button
                                    onClick={() => void handleCreate()}
                                    disabled={saving}
                                    className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : null}
                                    Issue key
                                </button>
                            </div>
                        </div>
                    ) : selected ? (
                        <div className="p-5 flex flex-col gap-5">
                            <div className="flex items-center justify-between gap-3 pb-4 border-b border-border">
                                <div className="min-w-0">
                                    <h2 className="text-base font-medium text-text-primary break-all">{selected.name}</h2>
                                    <p className="text-xs text-text-muted mt-0.5 font-mono">{selected.appId}</p>
                                </div>
                                <StatusBadge status={selected.status} />
                            </div>

                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                                <div>
                                    <dt className="text-xs text-text-muted">Created</dt>
                                    <dd className="text-text-primary">{new Date(selected.createdAt).toLocaleString()}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-text-muted">Created by</dt>
                                    <dd className="text-text-primary font-mono text-xs break-all">{selected.createdBy ?? '—'}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-text-muted">Last used</dt>
                                    <dd className="text-text-primary">{selected.lastUsedAt ? new Date(selected.lastUsedAt).toLocaleString() : 'Never'}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-text-muted">Expires</dt>
                                    <dd className="text-text-primary">{selected.expiresAt ? new Date(selected.expiresAt).toLocaleString() : 'Never'}</dd>
                                </div>
                                <div className="sm:col-span-2">
                                    <dt className="text-xs text-text-muted">ID</dt>
                                    <dd className="text-text-primary font-mono text-xs break-all">{selected.id}</dd>
                                </div>
                            </dl>

                            {error && (
                                <div role="alert" className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0" />{error}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                                <button
                                    onClick={() => void handleRotate(selected.id)}
                                    disabled={saving || selected.status === 'revoked'}
                                    className="flex items-center justify-center gap-1.5 rounded-sm border border-azure/50 bg-azure/10 px-4 py-2 text-sm font-medium text-azure hover:bg-azure/20 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    <RotateCw className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Rotate
                                </button>
                                <button
                                    onClick={() => setRevokeTarget(selected)}
                                    disabled={saving || selected.status === 'revoked'}
                                    className="flex items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-4 py-2 text-sm font-medium text-red hover:bg-red-dim/80 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Revoke
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center py-20">
                            <div className="text-center">
                                <KeyRound className="mx-auto mb-3 h-8 w-8 text-text-muted" />
                                <p className="text-sm text-text-muted">Select a key to view, or create a new one</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Issued-token dialog — token is shown ONCE */}
            {issued && (
                <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-lg rounded-sm border border-border bg-surface-1 p-5 flex flex-col gap-4">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="flex items-center gap-2 text-base font-medium text-text-primary">
                                <KeyRound className="h-4 w-4 text-azure" /> Key issued
                            </h2>
                            <button onClick={closeIssued} aria-label="Close" className="text-text-muted hover:text-text-secondary">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="flex items-center gap-2 rounded-sm border border-amber-700/50 bg-amber-dim/30 px-3 py-2.5 text-xs text-amber">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            This is the only time the raw token is shown. Copy and store it now.
                        </div>
                        <div className="text-xs text-text-muted">
                            <span className="font-mono">{issued.appId}</span> · {issued.name}
                        </div>
                        <pre className="overflow-x-auto rounded-sm border border-border bg-canvas px-3 py-2.5 font-mono text-xs text-text-primary whitespace-pre-wrap break-all">
                            {issued.token}
                        </pre>
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <button
                                onClick={() => void copyToken()}
                                className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                {copied ? <Check className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <Copy className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                                {copied ? 'Copied' : 'Copy token'}
                            </button>
                            <button
                                onClick={closeIssued}
                                className="flex items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-1 px-4 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                I&apos;ve stored it
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Revoke confirm dialog */}
            {revokeTarget && (
                <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-md rounded-sm border border-border bg-surface-1 p-5 flex flex-col gap-4">
                        <h2 className="flex items-center gap-2 text-base font-medium text-text-primary">
                            <Trash2 className="h-4 w-4 text-red" /> Revoke key
                        </h2>
                        <p className="text-sm text-text-secondary">
                            Revoke <span className="font-mono">{revokeTarget.appId}</span> / {revokeTarget.name}? Any service still using this token will start failing immediately.
                        </p>
                        {error && (
                            <div role="alert" className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 text-sm text-red">
                                <AlertCircle className="h-4 w-4 shrink-0" />{error}
                            </div>
                        )}
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <button
                                onClick={() => void handleRevoke(revokeTarget.id)}
                                disabled={saving}
                                className="flex items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-4 py-2 text-sm font-medium text-red hover:bg-red-dim/80 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                                Revoke
                            </button>
                            <button
                                onClick={() => { setRevokeTarget(null); setError(null) }}
                                disabled={saving}
                                className="flex items-center justify-center gap-1.5 rounded-sm border border-border bg-surface-1 px-4 py-2 text-sm text-text-muted hover:text-text-secondary disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
