// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    ShieldCheck, RefreshCw, Plus, X, Check, AlertCircle, Plug, KeyRound, Lock,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { authClient } from '@web/lib/auth-client'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

type GrantStatus = 'granted' | 'pending' | 'revoked'

interface Grant {
    id: string
    appId: string
    workspaceId: string
    allowedConnectors: string[]
    capabilities: string[]
    status: GrantStatus
    grantedBy: string | null
    grantedAt: string
    updatedAt: string
}

interface RegisteredApp {
    appId: string
    displayName: string | null
}

interface GrantsResponse {
    items: Grant[]
    total: number
    apps?: RegisteredApp[]
}

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

function StatusBadge({ status }: { status: GrantStatus }) {
    const styles: Record<GrantStatus, string> = {
        granted: 'border-green-700/50 bg-green-900/20 text-green-400',
        pending: 'border-amber-700/50 bg-amber-dim/30 text-amber',
        revoked: 'border-red-800/50 bg-red-dim text-red',
    }
    return (
        <span className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${styles[status]}`}>
            {status}
        </span>
    )
}

// ── Tag editor ────────────────────────────────────────────────────────────────

function TagInput({
    label, description, placeholder, tags, onChange, disabled, icon,
}: {
    label: string
    description?: string
    placeholder: string
    tags: string[]
    onChange: (next: string[]) => void
    disabled?: boolean
    icon?: React.ReactNode
}) {
    const [draft, setDraft] = useState('')

    function commit(raw: string) {
        const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
        if (parts.length === 0) return
        const next = [...new Set([...tags, ...parts])]
        onChange(next)
        setDraft('')
    }

    return (
        <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
                {icon}{label}
            </label>
            <div className="flex flex-wrap gap-1.5 rounded-sm border border-border bg-canvas p-2 min-h-[44px]">
                {tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2/60 px-2 py-0.5 text-xs font-mono text-text-secondary">
                        {t}
                        {!disabled && (
                            <button
                                onClick={() => onChange(tags.filter((x) => x !== t))}
                                aria-label={`Remove ${t}`}
                                className="text-text-muted hover:text-red transition-colors"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </span>
                ))}
                {!disabled && (
                    <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
                            if (e.key === 'Backspace' && draft === '' && tags.length > 0) onChange(tags.slice(0, -1))
                        }}
                        onBlur={() => commit(draft)}
                        placeholder={tags.length === 0 ? placeholder : 'Add…'}
                        className="flex-1 min-w-[120px] bg-transparent text-[16px] md:text-sm text-text-primary placeholder:text-text-muted outline-none"
                    />
                )}
            </div>
            {description && <p className="text-xs text-text-muted">{description}</p>}
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AppGrantsPage() {
    const { workspaceId: ctxWorkspaceId, workspace } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [grants, setGrants] = useState<Grant[]>([])
    const [apps, setApps] = useState<RegisteredApp[]>([])
    const [loading, setLoading] = useState(true)
    const [canEdit, setCanEdit] = useState(false)

    // Editor state — `selectedAppId === ''` while composing a brand-new grant.
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
    const [draftAppId, setDraftAppId] = useState('')
    const [connectors, setConnectors] = useState<string[]>([])
    const [capabilities, setCapabilities] = useState<string[]>([])
    const [status, setStatus] = useState<GrantStatus>('granted')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)

    const fetchGrants = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/app-grants/${WS_ID}`)
            if (res.ok) {
                const data = await res.json() as GrantsResponse
                setGrants(data.items ?? [])
                setApps(data.apps ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchGrants() }, [fetchGrants])

    // Determine edit privilege: owner (from context) or admin (from membership).
    useEffect(() => {
        let cancelled = false
        async function resolveRole() {
            if (!WS_ID) return
            try {
                const session = await authClient.getSession()
                const userId = session.data?.user?.id
                if (!userId) return
                if (workspace?.ownerId && workspace.ownerId === userId) {
                    if (!cancelled) setCanEdit(true)
                    return
                }
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/members`)
                if (!res.ok) return
                const data = await res.json() as { items: { userId: string; role: MemberRole }[] }
                const me = data.items?.find((m) => m.userId === userId)
                if (!cancelled && (me?.role === 'admin' || me?.role === 'owner')) setCanEdit(true)
            } catch { /* default: read-only */ }
        }
        void resolveRole()
        return () => { cancelled = true }
    }, [WS_ID, workspace?.ownerId])

    function selectGrant(g: Grant) {
        setCreating(false)
        setSelectedAppId(g.appId)
        setConnectors(g.allowedConnectors ?? [])
        setCapabilities(g.capabilities ?? [])
        setStatus(g.status)
        setError(null)
        setSaved(false)
    }

    function startCreate() {
        setCreating(true)
        setSelectedAppId('')
        setDraftAppId('')
        setConnectors([])
        setCapabilities([])
        setStatus('granted')
        setError(null)
        setSaved(false)
    }

    const effectiveAppId = creating ? draftAppId.trim() : (selectedAppId ?? '')

    async function handleSave() {
        if (!WS_ID || !effectiveAppId) return
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/app-grants/${WS_ID}/${encodeURIComponent(effectiveAppId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allowedConnectors: connectors, capabilities, status }),
            })
            if (res.ok) {
                setSaved(true)
                setTimeout(() => setSaved(false), 2000)
                setCreating(false)
                setSelectedAppId(effectiveAppId)
                await fetchGrants()
            } else {
                const d = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setError(d.error?.message ?? `Save failed (${res.status})`)
            }
        } catch {
            setError('Network error')
        } finally {
            setSaving(false)
        }
    }

    const pendingCount = useMemo(() => grants.filter((g) => g.status === 'pending').length, [grants])
    // Apps with no grant row yet — candidates for a proactive grant.
    const ungranted = useMemo(() => {
        const have = new Set(grants.map((g) => g.appId))
        return apps.filter((a) => !have.has(a.appId))
    }, [apps, grants])

    const editorOpen = creating || selectedAppId !== null

    if (!WS_ID) {
        return (
            <div className="flex items-center justify-center py-20 text-sm text-text-muted">
                No workspace selected. Choose a workspace from the sidebar.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-medium text-text-primary">
                        <ShieldCheck className="h-6 w-6 text-azure" /> App Grants
                    </h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Per-app capability grants for this workspace. Apps get nothing until you grant it
                        (default-deny). {pendingCount > 0 && <span className="text-amber">{pendingCount} pending request{pendingCount !== 1 ? 's' : ''}.</span>}
                    </p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                        onClick={startCreate}
                        disabled={!canEdit}
                        className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                    >
                        <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> New grant
                    </button>
                    <button
                        onClick={() => void fetchGrants()}
                        disabled={loading}
                        aria-label="Refresh grants"
                        className="flex items-center justify-center rounded-sm border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors min-h-[44px] min-w-[44px] shrink-0"
                    >
                        <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {!canEdit && (
                <div className="flex items-center gap-2 rounded-sm border border-yellow-800/30 bg-amber-dim/10 px-3 py-2.5 text-xs text-yellow-500/80">
                    <Lock className="h-3.5 w-3.5 shrink-0" />
                    Read-only — changing grants requires the workspace owner or an admin.
                </div>
            )}

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pb-4 md:pb-0">
                {/* Left — grant list */}
                <div className="w-full md:w-[280px] shrink-0 flex flex-col gap-1 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-text-muted">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : grants.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-text-muted text-center px-4">
                            <ShieldCheck className="h-6 w-6 text-text-muted" />
                            No grants yet
                        </div>
                    ) : grants.map((g) => {
                        const active = !creating && selectedAppId === g.appId
                        return (
                            <button
                                key={g.id}
                                onClick={() => selectGrant(g)}
                                className={`text-left rounded-sm border p-3 transition-all w-full min-h-[44px] ${active
                                    ? 'border-azure/50 bg-surface-1'
                                    : 'border-border bg-surface-1/40 hover:border-border'
                                    }`}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-text-primary font-mono truncate">{g.appId}</span>
                                    <StatusBadge status={g.status} />
                                </div>
                                <p className="mt-1 text-[11px] text-text-muted">
                                    {g.allowedConnectors.length} connector{g.allowedConnectors.length !== 1 ? 's' : ''} · {g.capabilities.length} capabilit{g.capabilities.length !== 1 ? 'ies' : 'y'}
                                </p>
                            </button>
                        )
                    })}
                </div>

                {/* Right — editor */}
                <div className="flex-1 rounded-sm border border-border bg-surface-1/40 overflow-y-auto">
                    {!editorOpen ? (
                        <div className="flex h-full items-center justify-center py-20">
                            <div className="text-center">
                                <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-text-muted" />
                                <p className="text-sm text-text-muted">Select a grant to edit, or create a new one</p>
                            </div>
                        </div>
                    ) : (
                        <div className="p-5 flex flex-col gap-5">
                            {/* App identity */}
                            {creating ? (
                                <div className="flex flex-col gap-1.5">
                                    <label htmlFor="grant-app-id" className="text-sm font-medium text-text-secondary">App ID</label>
                                    <input
                                        id="grant-app-id"
                                        list="registered-apps"
                                        value={draftAppId}
                                        onChange={(e) => setDraftAppId(e.target.value)}
                                        placeholder="e.g. levio"
                                        disabled={!canEdit}
                                        className="rounded-sm border border-border bg-canvas px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring disabled:opacity-50 min-h-[44px] font-mono"
                                    />
                                    <datalist id="registered-apps">
                                        {ungranted.map((a) => (
                                            <option key={a.appId} value={a.appId}>{a.displayName ?? a.appId}</option>
                                        ))}
                                    </datalist>
                                    <p className="text-xs text-text-muted">The registered app slug (X-App-Id). Registered apps without a grant are suggested.</p>
                                </div>
                            ) : (
                                <div className="flex items-center justify-between gap-3 pb-4 border-b border-border">
                                    <div>
                                        <h2 className="text-base font-medium text-text-primary font-mono break-all">{selectedAppId}</h2>
                                        <p className="text-xs text-text-muted mt-0.5">Workspace grant</p>
                                    </div>
                                    <StatusBadge status={status} />
                                </div>
                            )}

                            {/* Status */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Status</label>
                                <div className="flex gap-2 flex-wrap">
                                    {(['granted', 'pending', 'revoked'] as GrantStatus[]).map((s) => (
                                        <button
                                            key={s}
                                            onClick={() => setStatus(s)}
                                            disabled={!canEdit}
                                            className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-[16px] md:text-sm transition-all min-h-[44px] md:min-h-0 disabled:opacity-50 ${status === s
                                                ? 'border-azure/50 bg-azure/10 text-azure'
                                                : 'border-border text-text-muted hover:border-border'
                                                }`}
                                        >
                                            <StatusBadge status={s} />
                                        </button>
                                    ))}
                                </div>
                                <p className="text-xs text-text-muted">
                                    Only <span className="font-mono">granted</span> rows are enforced — <span className="font-mono">pending</span> (an app&apos;s un-approved request) and <span className="font-mono">revoked</span> resolve to deny-all.
                                </p>
                            </div>

                            <TagInput
                                label="Allowed connectors"
                                icon={<Plug className="h-3.5 w-3.5 text-text-muted" />}
                                placeholder="e.g. github, gmail"
                                description="Connector registry IDs the app may use. Exact match (no wildcards)."
                                tags={connectors}
                                onChange={setConnectors}
                                disabled={!canEdit}
                            />

                            <TagInput
                                label="Capabilities"
                                icon={<KeyRound className="h-3.5 w-3.5 text-text-muted" />}
                                placeholder="e.g. memory:read:*"
                                description="Extension capability tokens. Supports * (all) and prefix:* (e.g. memory:read:*)."
                                tags={capabilities}
                                onChange={setCapabilities}
                                disabled={!canEdit}
                            />

                            {error && (
                                <div role="alert" className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2.5 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0" />{error}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                                <button
                                    onClick={() => void handleSave()}
                                    disabled={saving || !canEdit || !effectiveAppId}
                                    className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                >
                                    {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : saved ? <Check className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : null}
                                    {saved ? 'Saved' : creating ? 'Create grant' : 'Save grant'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
