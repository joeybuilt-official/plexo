// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import {
    Network,
    RefreshCw,
    Plus,
    Trash2,
    Check,
    X,
    AlertCircle,
    CheckCircle2,
    Clock,
    Shield,
    ShieldCheck,
    ShieldOff,
    Globe,
    Copy,
    ChevronDown,
    ChevronRight,
} from 'lucide-react'

import { useConfirm } from '@web/components/ui/confirm-dialog'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')

// ── Types ─────────────────────────────────────────────────────────────────────

interface Node {
    id: string
    did: string
    displayName: string | null
    url: string | null
    isSelf: boolean
    status: string
    lastPingAt: string | null
    createdAt: string
    trust: NodeTrust | null
}

interface NodeTrust {
    id: string
    localNodeId: string
    remoteNodeId: string
    memorySync: boolean
    agentRouting: boolean
    eventPropagation: boolean
    establishedAt: string
    revokedAt: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, { label: string; cls: string }> = {
        active:  { label: 'Active',  cls: 'border-emerald-700/50 bg-surface-2/30 text-emerald-400' },
        pending: { label: 'Pending', cls: 'border-yellow-700/50 bg-amber-dim/30 text-yellow-400' },
        revoked: { label: 'Revoked', cls: 'border-red-700/50 bg-red-dim text-red-400' },
    }
    const { label, cls } = map[status] ?? { label: status, cls: 'border-border bg-surface-2/50 text-text-muted' }
    return (
        <span className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-mono font-medium uppercase tracking-wider ${cls}`}>
            [{label}]
        </span>
    )
}

function TrustToggle({ label, active, onChange }: { label: string; active: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="flex items-center gap-2 cursor-pointer select-none min-h-[44px]">
            <button
                type="button"
                onClick={() => onChange(!active)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${active ? 'bg-azure' : 'bg-surface-3'}`}
            >
                <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${active ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <span className="text-xs text-text-secondary">{label}</span>
        </label>
    )
}

// ── Add Node Modal ────────────────────────────────────────────────────────────

function AddNodeModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
    const [did, setDid] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [url, setUrl] = useState('')
    const [memorySync, setMemorySync] = useState(false)
    const [agentRouting, setAgentRouting] = useState(false)
    const [eventPropagation, setEventPropagation] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const trapRef = useFocusTrap<HTMLDivElement>(true)

    async function submit() {
        if (!did.trim()) { setError('DID is required'); return }
        setSaving(true)
        setError(null)
        try {
            const r = await fetch(`${API_BASE}/api/v1/nodes/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    did: did.trim(),
                    displayName: displayName.trim() || undefined,
                    url: url.trim() || undefined,
                    trust: { memorySync, agentRouting, eventPropagation },
                }),
            })
            const data = await r.json()
            if (!r.ok) throw new Error(data.error?.message ?? 'Failed to pair node')
            onAdded()
            onClose()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-node-modal-title"
        >
            <div
                className="w-full max-w-md rounded-sm border border-border bg-surface-1 p-6"
                onClick={e => e.stopPropagation()}
            >
                <div className="mb-4 flex items-center justify-between">
                    <h3 id="add-node-modal-title" className="text-sm font-medium text-text-primary">Pair Remote Node</h3>
                    <button onClick={onClose} aria-label="Close pair dialog" className="text-text-muted hover:text-text-primary"><X className="h-4 w-4" /></button>
                </div>

                <div className="space-y-3">
                    <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-muted uppercase tracking-wider">Node DID *</label>
                        <input
                            value={did}
                            onChange={e => setDid(e.target.value)}
                            placeholder="did:plexo:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            className="w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-muted uppercase tracking-wider">Display Name</label>
                        <input
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            placeholder="Production EU node"
                            className="w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-muted uppercase tracking-wider">URL</label>
                        <input
                            value={url}
                            onChange={e => setUrl(e.target.value)}
                            placeholder="https://plexo.example.com"
                            className="w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                        />
                    </div>

                    <div className="rounded-sm border border-border bg-surface-2/50 p-3 space-y-2">
                        <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Trust Scopes</p>
                        <TrustToggle label="Memory Sync" active={memorySync} onChange={setMemorySync} />
                        <TrustToggle label="Agent Routing" active={agentRouting} onChange={setAgentRouting} />
                        <TrustToggle label="Event Propagation" active={eventPropagation} onChange={setEventPropagation} />
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 text-xs text-red-400" role="alert">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            {error}
                        </div>
                    )}
                </div>

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 disabled:opacity-50 transition-colors"
                    >
                        {saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                        Pair Node
                    </button>
                </div>
            </div>
        </div>
    )
}

// ── Node Row ──────────────────────────────────────────────────────────────────

function NodeRow({ node, onDeleted, onTrustUpdated }: { node: Node; onDeleted: () => void; onTrustUpdated: () => void }) {
    const [expanded, setExpanded] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [copied, setCopied] = useState(false)
    const confirmAction = useConfirm()

    async function deleteNode() {
        if (!await confirmAction({ title: 'Remove node', description: `Remove node "${node.displayName ?? node.did}"? This cannot be undone.`, confirmLabel: 'Remove', variant: 'danger' })) return
        setDeleting(true)
        try {
            await fetch(`${API_BASE}/api/v1/nodes/${node.id}`, {
                method: 'DELETE',
                credentials: 'include',
            })
            onDeleted()
        } finally {
            setDeleting(false)
        }
    }

    function copyDid() {
        navigator.clipboard.writeText(node.did)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className="rounded-sm border border-border bg-surface-1 overflow-hidden">
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-2/50 transition-colors"
                onClick={() => !node.isSelf && setExpanded(v => !v)}
            >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-2">
                    {node.isSelf
                        ? <ShieldCheck className="h-4 w-4 text-azure" />
                        : <Globe className="h-4 w-4 text-text-muted" />
                    }
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">
                            {node.displayName ?? node.did.slice(0, 32) + '…'}
                        </span>
                        {node.isSelf && (
                            <span className="rounded-sm border border-azure/40 bg-azure/10 px-1.5 py-0.5 text-[11px] font-medium text-azure">SELF</span>
                        )}
                        <StatusBadge status={node.status} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-text-muted font-mono truncate">{node.did}</span>
                        <button
                            onClick={e => { e.stopPropagation(); copyDid() }}
                            className="shrink-0 text-text-muted hover:text-text-secondary transition-colors"
                        >
                            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        </button>
                    </div>
                    {node.lastPingAt && (
                        <p className="text-[11px] text-text-muted mt-0.5">Last ping {timeAgo(node.lastPingAt)}</p>
                    )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {!node.isSelf && (
                        <button
                            onClick={e => { e.stopPropagation(); deleteNode() }}
                            disabled={deleting}
                            aria-label="Delete federation node"
                            className="rounded p-1 text-text-muted hover:text-red-400 hover:bg-red-dim transition-colors"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                    {!node.isSelf && (
                        expanded
                            ? <ChevronDown className="h-4 w-4 text-text-muted" />
                            : <ChevronRight className="h-4 w-4 text-text-muted" />
                    )}
                </div>
            </div>

            {expanded && !node.isSelf && (
                <TrustPanel nodeId={node.id} initialTrust={node.trust} onUpdated={onTrustUpdated} />
            )}
        </div>
    )
}

// ── Trust Panel ───────────────────────────────────────────────────────────────

function TrustPanel({ nodeId, initialTrust, onUpdated }: { nodeId: string; initialTrust: NodeTrust | null; onUpdated: () => void }) {
    const [trust, setTrust] = useState<NodeTrust | null>(initialTrust)
    const [saving, setSaving] = useState(false)
    const confirmAction = useConfirm()

    // Keep local state in sync when parent refreshes
    useEffect(() => { setTrust(initialTrust) }, [initialTrust])

    async function updateTrust(field: 'memorySync' | 'agentRouting' | 'eventPropagation', value: boolean) {
        setSaving(true)
        // Optimistic update
        setTrust(prev => prev ? { ...prev, [field]: value } : { id: '', localNodeId: '', remoteNodeId: nodeId, memorySync: false, agentRouting: false, eventPropagation: false, establishedAt: '', revokedAt: null, [field]: value })
        try {
            await fetch(`${API_BASE}/api/v1/nodes/${nodeId}/trust`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ [field]: value }),
            })
            onUpdated()
        } finally {
            setSaving(false)
        }
    }

    async function revokeAll() {
        if (!await confirmAction({ title: 'Revoke trust', description: 'Revoke all trust for this node?', confirmLabel: 'Revoke', variant: 'danger' })) return
        setSaving(true)
        setTrust(prev => prev ? { ...prev, revokedAt: new Date().toISOString() } : null)
        try {
            await fetch(`${API_BASE}/api/v1/nodes/${nodeId}/trust`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ revoke: true }),
            })
            onUpdated()
        } finally {
            setSaving(false)
        }
    }

    const isRevoked = !!trust?.revokedAt

    return (
        <div className="border-t border-border bg-surface-2/30 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Trust Scopes</p>
                <button
                    onClick={revokeAll}
                    disabled={saving || isRevoked}
                    className="inline-flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                >
                    <ShieldOff className="h-3 w-3" />
                    Revoke all
                </button>
            </div>
            {isRevoked && (
                <p className="text-[11px] text-red-400">Trust revoked — re-pair this node to restore access.</p>
            )}
            <div className={`space-y-2 ${isRevoked ? 'opacity-40 pointer-events-none' : ''}`}>
                {(['memorySync', 'agentRouting', 'eventPropagation'] as const).map(scope => {
                    const labels: Record<string, string> = {
                        memorySync: 'Memory Sync',
                        agentRouting: 'Agent Routing',
                        eventPropagation: 'Event Propagation',
                    }
                    return (
                        <TrustToggle
                            key={scope}
                            label={labels[scope]}
                            active={trust ? trust[scope] : false}
                            onChange={v => void updateTrust(scope, v)}
                        />
                    )
                })}
            </div>
            <p className="text-[11px] text-text-muted">
                Changes take effect immediately. Both nodes must establish trust for a scope to be active.
            </p>
        </div>
    )
}

// ── App Profiles Panel ────────────────────────────────────────────────────────

interface AppProfile {
    appId: string
    schemaNamespace: string
    displayName: string
    lastSeenAt: string | null
}

function AppProfilesPanel() {
    const [profiles, setProfiles] = useState<AppProfile[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch(`${API_BASE}/api/v1/profiles`, { credentials: 'include' })
            const data = await r.json()
            if (!r.ok) throw new Error(data.error?.message ?? 'Failed to load profiles')
            setProfiles(data.items ?? [])
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])

    if (loading) return <div className="py-6 text-center text-xs text-text-muted">Loading app profiles…</div>
    if (error) return (
        <div className="flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 text-xs text-red-400" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
    )
    if (profiles.length === 0) return (
        <div className="rounded-sm border border-dashed border-border px-4 py-6 text-center">
            <p className="text-xs text-text-muted">No app profiles registered. External Joeybuilt apps (fylo, fonto, etc.) register automatically on startup.</p>
        </div>
    )

    return (
        <div className="space-y-2">
            {profiles.map(p => (
                <div key={p.appId} className="flex items-center gap-3 rounded-sm border border-border bg-surface-1 px-4 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-2 text-xs font-medium text-azure">
                        {p.displayName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text-primary">{p.displayName}</p>
                        <p className="text-[11px] text-text-muted font-mono">{p.appId} · ns:{p.schemaNamespace}</p>
                    </div>
                    <div className="shrink-0 text-right">
                        {p.lastSeenAt
                            ? <p className="text-[11px] text-text-muted flex items-center gap-1"><Clock className="h-3 w-3" />{timeAgo(p.lastSeenAt)}</p>
                            : <p className="text-[11px] text-text-muted">Never seen</p>
                        }
                    </div>
                </div>
            ))}
        </div>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FederationPage() {
    const [nodes, setNodes] = useState<Node[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showAdd, setShowAdd] = useState(false)
    const [selfDid, setSelfDid] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const loadNodes = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch(`${API_BASE}/api/v1/nodes`, { credentials: 'include' })
            const data = await r.json()
            if (!r.ok) throw new Error(data.error?.message ?? 'Failed to load nodes')
            setNodes(data.items ?? [])
            const self = (data.items as Node[]).find(n => n.isSelf)
            setSelfDid(self?.did ?? null)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void loadNodes() }, [loadNodes])

    function copySelfDid() {
        if (!selfDid) return
        navigator.clipboard.writeText(selfDid)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    const remoteNodes = nodes.filter(n => !n.isSelf)

    return (
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
            {showAdd && <AddNodeModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void loadNodes() }} />}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-lg font-medium text-text-primary flex items-center gap-2">
                        <Network className="h-5 w-5 text-azure" />
                        Federation
                    </h1>
                    <p className="mt-0.5 text-sm text-text-muted">Connect this Plexo instance to other nodes in a trusted mesh.</p>
                </div>
                <button
                    onClick={() => void loadNodes()}
                    aria-label="Refresh federation nodes"
                    className="rounded-sm border border-border p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Self Node Identity */}
            <section>
                <h2 className="mb-3 text-xs font-medium text-text-muted uppercase tracking-wider">This Node</h2>
                {selfDid ? (
                    <div className="flex items-center gap-3 rounded-sm border border-azure/30 bg-azure/5 px-4 py-3">
                        <ShieldCheck className="h-5 w-5 shrink-0 text-azure" />
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-text-secondary">Node DID — share this with remote nodes to initiate pairing</p>
                            <p className="mt-0.5 text-[11px] font-mono text-text-primary break-all">{selfDid}</p>
                        </div>
                        <button
                            onClick={copySelfDid}
                            className="shrink-0 rounded p-1 text-text-muted hover:text-azure transition-colors"
                        >
                            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                        </button>
                    </div>
                ) : (
                    <div className="rounded-sm border border-yellow-700/40 bg-amber-dim/20 px-4 py-3 text-xs text-yellow-400">
                        Self-node not initialised. Set PLEXO_INSTANCE_ID and restart.
                    </div>
                )}
            </section>

            {/* Remote Nodes */}
            <section>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                        Remote Nodes ({remoteNodes.length})
                    </h2>
                    <button
                        onClick={() => setShowAdd(true)}
                        className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                    >
                        <Plus className="h-3 w-3" />
                        Pair Node
                    </button>
                </div>

                {error && (
                    <div className="mb-3 flex items-center gap-2 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 text-xs text-red-400" role="alert">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
                    </div>
                )}

                {loading ? (
                    <div className="py-8 text-center text-xs text-text-muted">Loading nodes…</div>
                ) : remoteNodes.length === 0 ? (
                    <div className="rounded-sm border border-dashed border-border px-4 py-8 text-center">
                        <Network className="mx-auto mb-2 h-8 w-8 text-text-muted/40" />
                        <p className="text-sm font-medium text-text-secondary">No remote nodes</p>
                        <p className="mt-1 text-xs text-text-muted">Pair another Plexo instance to enable federation.</p>
                        <button
                            onClick={() => setShowAdd(true)}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors"
                        >
                            <Plus className="h-3 w-3" /> Pair your first node
                        </button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {remoteNodes.map(node => (
                            <NodeRow
                                key={node.id}
                                node={node}
                                onDeleted={loadNodes}
                                onTrustUpdated={loadNodes}
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* App Profiles */}
            <section>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider">Registered App Profiles</h2>
                </div>
                <AppProfilesPanel />
            </section>
        </div>
    )
}
