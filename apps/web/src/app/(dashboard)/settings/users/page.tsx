// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    Users,
    RefreshCw,
    Shield,
    ShieldCheck,
    Mail,
    Clock,
    Link2, Copy, Check, AlertCircle, UserPlus, Trash2, Crown, Eye, X
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

interface Member {
    id: string
    userId: string
    role: MemberRole
    joinedAt: string
    name: string | null
    email: string
}

interface Invite {
    token: string
    inviteUrl: string
    expiresAt: string
    role: MemberRole
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
    return new Date(iso).toLocaleDateString()
}

function initials(name: string | null, email: string): string {
    if (name) return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
    return email[0].toUpperCase()
}

function RoleBadge({ role }: { role: MemberRole }) {
    const styles: Record<MemberRole, string> = {
        owner: 'border-yellow-700/50 bg-yellow-950/30 text-yellow-400',
        admin: 'border-amber-700/50 bg-amber-950/30 text-amber-400',
        member: 'border-zinc-700 bg-zinc-800/50 text-zinc-400',
        viewer: 'border-zinc-800 bg-zinc-900 text-zinc-600',
    }
    const icons: Record<MemberRole, React.ReactNode> = {
        owner: <Crown className="h-3 w-3" />,
        admin: <ShieldCheck className="h-3 w-3" />,
        member: <Shield className="h-3 w-3" />,
        viewer: <Eye className="h-3 w-3" />,
    }
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles[role]}`}>
            {icons[role]}{role}
        </span>
    )
}

const FILTER_KEYS = ['role'] as const

// ── Invite panel ──────────────────────────────────────────────────────────────

function InvitePanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
    const [role, setRole] = useState<MemberRole>('member')
    const [email, setEmail] = useState('')
    const [creating, setCreating] = useState(false)
    const [invite, setInvite] = useState<Invite | null>(null)
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function createInvite() {
        setCreating(true)
        setError(null)
        try {
            // Use first available user as invitedByUserId (placeholder until auth is wired)
            const usersRes = await fetch(`${API_BASE}/api/v1/users`)
            const usersData = await usersRes.json() as { items: { id: string }[] }
            const fallbackUserId = usersData.items?.[0]?.id ?? '00000000-0000-0000-0000-000000000001'

            const res = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/members/invite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email || undefined, role, invitedByUserId: fallbackUserId }),
            })
            if (res.ok) {
                const data = await res.json() as Invite
                setInvite(data)
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Failed to create invite')
            }
        } catch {
            setError('Network error')
        } finally {
            setCreating(false)
        }
    }

    function copyLink() {
        if (!invite) return
        void navigator.clipboard.writeText(invite.inviteUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const roles: MemberRole[] = ['viewer', 'member', 'admin']

    return (
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-900 p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <Link2 className="h-4 w-4 text-indigo-400" />
                    Create invite link
                </div>
                <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2 -mt-2">
                    <X className="h-5 w-5 md:h-4 md:w-4" />
                </button>
            </div>

            {!invite ? (
                <>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-zinc-400">Email (optional — leave blank for open link)</label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="colleague@example.com"
                            className="min-h-[44px] rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-[16px] sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-zinc-400">Role</label>
                        <div className="flex gap-2">
                            {roles.map((r) => (
                                <button
                                    key={r}
                                    onClick={() => setRole(r)}
                                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 min-h-[44px] md:min-h-0 text-xs capitalize transition-all ${role === r
                                        ? 'border-indigo-500/50 bg-indigo-600/10 text-indigo-300'
                                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'
                                        }`}
                                >
                                    <RoleBadge role={r} />
                                </button>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
                        </div>
                    )}

                    <button
                        onClick={() => void createInvite()}
                        disabled={creating}
                        className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors min-h-[44px]"
                    >
                        {creating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                        Generate link
                    </button>
                </>
            ) : (
                <div className="flex flex-col gap-3">
                    <p className="text-xs text-zinc-500">
                        Expires {timeAgo(invite.expiresAt)} — share this link with your teammate
                    </p>
                    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 pl-3">
                        <span className="flex-1 truncate font-mono text-[16px] md:text-sm text-zinc-400">{invite.inviteUrl}</span>
                        <button onClick={copyLink} className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] text-zinc-500 hover:text-zinc-300 transition-colors">
                            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                        </button>
                    </div>
                    <button
                        onClick={() => setInvite(null)}
                        className="text-[16px] md:text-sm min-h-[44px] md:min-h-0 text-zinc-600 hover:text-zinc-400 text-left transition-colors"
                    >
                        Create another
                    </button>
                </div>
            )}
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [members, setMembers] = useState<Member[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Member | null>(null)
    const [editRole, setEditRole] = useState<MemberRole>('member')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [removing, setRemoving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showInvite, setShowInvite] = useState(false)

    const lf = useListFilter(FILTER_KEYS, 'joined_desc')
    const { search, filterValues, clearAll } = lf

    const fetchMembers = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/members`)
            if (res.ok) {
                const data = await res.json() as { items: Member[] }
                setMembers(data.items ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchMembers() }, [fetchMembers])

    function selectMember(m: Member) {
        setSelected(m)
        setEditRole(m.role)
        setError(null)
        setSaved(false)
    }

    async function handleSaveRole() {
        if (!selected || !WS_ID) return
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/members/${selected.userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: editRole }),
            })
            if (res.ok) {
                setSaved(true)
                setTimeout(() => setSaved(false), 2000)
                setMembers((prev) => prev.map((m) => m.userId === selected.userId ? { ...m, role: editRole } : m))
                setSelected((s) => s ? { ...s, role: editRole } : s)
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Save failed')
            }
        } finally {
            setSaving(false)
        }
    }

    async function handleRemove() {
        if (!selected || !WS_ID) return
        if (!confirm(`Remove ${selected.name ?? selected.email} from this workspace?`)) return
        setRemoving(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/members/${selected.userId}`, { method: 'DELETE' })
            if (res.ok) {
                setMembers((prev) => prev.filter((m) => m.userId !== selected.userId))
                setSelected(null)
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Remove failed')
            }
        } finally {
            setRemoving(false)
        }
    }

    const displayed = useMemo(() => {
        let res = members
        const q = search.trim().toLowerCase()
        if (filterValues.role) {
            res = res.filter((m) => m.role === filterValues.role)
        }
        if (q) {
            res = res.filter(
                (m) =>
                    (m.name?.toLowerCase().includes(q) ?? false) ||
                    m.email.toLowerCase().includes(q)
            )
        }
        res = [...res].sort((a, b) => {
            if (lf.sort === 'joined_asc') return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
            if (lf.sort === 'name_asc') return (a.name || a.email).localeCompare(b.name || b.email)
            if (lf.sort === 'name_desc') return (b.name || b.email).localeCompare(a.name || a.email)
            // joined_desc
            return new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime()
        })
        return res
    }, [members, search, filterValues.role, lf.sort])

    const availableRoles = useMemo(() => new Set(members.map((m) => m.role)), [members])

    const dimensions = useMemo(
        (): FilterDimension[] => [
            {
                key: 'role',
                label: 'Role',
                options: (['owner', 'admin', 'member', 'viewer'] as MemberRole[]).map((r) => ({
                    value: r,
                    label: r,
                    dimmed: !availableRoles.has(r),
                })),
            },
        ],
        [availableRoles]
    )

    const ownerCount = members.filter((m) => m.role === 'owner').length

    if (!WS_ID) {
        return (
            <div className="flex items-center justify-center py-20 text-sm text-zinc-500">
                No workspace selected. Choose a workspace from the sidebar.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Members</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        {members.length} member{members.length !== 1 ? 's' : ''} in this workspace
                    </p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                        onClick={() => setShowInvite((v) => !v)}
                        className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                    >
                        <UserPlus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                        Invite
                    </button>
                    <button
                        onClick={() => void fetchMembers()}
                        disabled={loading}
                        className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] min-w-[44px] shrink-0"
                    >
                        <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Invite panel */}
            {showInvite && <InvitePanel workspaceId={WS_ID} onClose={() => setShowInvite(false)} />}

            {/* ListToolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search members by name or email…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest joined', value: 'joined_desc' },
                    { label: 'Oldest joined', value: 'joined_asc' },
                    { label: 'Name (A-Z)', value: 'name_asc' },
                    { label: 'Name (Z-A)', value: 'name_desc' },
                ]}
            />

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pb-4 md:pb-0">
                {/* Left — member list */}
                <div className="w-full md:w-[260px] shrink-0 flex flex-row md:flex-col gap-2 md:gap-1 overflow-x-auto md:overflow-y-auto pb-2 md:pb-0 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-zinc-600 min-w-[200px] shrink-0 snap-start">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : displayed.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-zinc-600 text-center px-4 min-w-[200px] shrink-0 snap-start">
                            <Users className="h-6 w-6 text-zinc-700" />
                            {lf.hasFilters ? 'No members match your filters' : 'No members yet'}
                            {lf.hasFilters && (
                                <button
                                    onClick={clearAll}
                                    className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 min-h-[44px] min-w-[44px]"
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : displayed.map((m) => {
                        const active = selected?.userId === m.userId
                        return (
                            <button
                                key={m.userId}
                                onClick={() => selectMember(m)}
                                className={`text-left rounded-xl border p-3 transition-all shrink-0 snap-start min-w-[250px] md:min-w-0 md:w-full min-h-[44px] ${active
                                    ? 'border-indigo-500/50 bg-zinc-900 shadow-sm shadow-indigo-500/10'
                                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                                    }`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-bold text-indigo-400 shrink-0">
                                        {initials(m.name, m.email)}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-zinc-200 truncate">
                                            {m.name ?? m.email.split('@')[0]}
                                        </p>
                                        <p className="text-[10px] text-zinc-600 truncate">{m.email}</p>
                                    </div>
                                    <RoleBadge role={m.role} />
                                </div>
                            </button>
                        )
                    })}
                </div>

                {/* Right — member detail */}
                <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-y-auto max-w-[100vw] sm:max-w-none">
                    {!selected ? (
                        <div className="flex h-full items-center justify-center py-20">
                            <div className="text-center">
                                <Users className="mx-auto mb-3 h-8 w-8 text-zinc-700" />
                                <p className="text-sm text-zinc-500">Select a member to manage their access</p>
                            </div>
                        </div>
                    ) : (
                        <div className="p-5 flex flex-col gap-5">
                            {/* Member header */}
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-4 border-b border-zinc-800">
                                <div className="flex flex-row items-center gap-3">
                                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/20 text-xl font-bold text-indigo-400 shrink-0">
                                        {initials(selected.name, selected.email)}
                                    </div>
                                    <div>
                                        <h2 className="text-base font-semibold text-zinc-100 break-all">
                                            {selected.name ?? selected.email.split('@')[0]}
                                        </h2>
                                        <div className="flex items-center gap-1.5 mt-1">
                                            <Mail className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                            <span className="text-sm text-zinc-500 break-all">{selected.email}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                            <Clock className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                            <span className="text-xs text-zinc-600">Joined {timeAgo(selected.joinedAt)}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="sm:ml-auto self-start sm:self-auto"><RoleBadge role={selected.role} /></div>
                            </div>

                            {/* Role editor */}
                            {selected.role !== 'owner' && (
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-sm font-medium text-zinc-300">Workspace role</label>
                                    <div className="flex gap-2 flex-wrap">
                                        {(['viewer', 'member', 'admin'] as MemberRole[]).map((r) => (
                                            <button
                                                key={r}
                                                onClick={() => setEditRole(r)}
                                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[16px] md:text-sm transition-all min-h-[44px] md:min-h-0 ${editRole === r
                                                    ? 'border-indigo-500/50 bg-indigo-600/10 text-indigo-300'
                                                    : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'
                                                    }`}
                                            >
                                                <RoleBadge role={r} />
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-xs text-zinc-600">
                                        {editRole === 'admin' && 'Can manage workspace settings, channels, and members.'}
                                        {editRole === 'member' && 'Can create tasks and view all workspace data.'}
                                        {editRole === 'viewer' && 'Read-only access to workspace data.'}
                                    </p>
                                </div>
                            )}

                            {selected.role === 'owner' && (
                                <div className="rounded-lg border border-yellow-800/30 bg-yellow-950/10 px-3 py-2.5 text-xs text-yellow-500/80">
                                    Workspace owner — role cannot be changed here. Transfer ownership in Settings &gt; Workspace.
                                </div>
                            )}

                            {/* Member ID */}
                            <div className="rounded-lg bg-zinc-950 px-3 py-2 flex items-center justify-between">
                                <span className="text-xs text-zinc-600">User ID</span>
                                <span className="font-mono text-[11px] text-zinc-500">{selected.userId}</span>
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2.5 text-sm text-red-400">
                                    <AlertCircle className="h-4 w-4 shrink-0" />{error}
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1 mt-auto sm:mt-0">
                                {selected.role !== 'owner' && (
                                    <>
                                        <button
                                            onClick={() => void handleSaveRole()}
                                            disabled={saving || editRole === selected.role}
                                            className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                        >
                                            {saving ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : saved ? <Check className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-emerald-400" /> : null}
                                            {saved ? 'Saved' : 'Save role'}
                                        </button>
                                        <button
                                            onClick={() => void handleRemove()}
                                            disabled={removing || ownerCount === members.length}
                                            className="flex items-center justify-center gap-1.5 rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2 text-sm text-red-400 hover:bg-red-950/40 disabled:opacity-50 transition-colors min-h-[44px] flex-1 sm:flex-initial"
                                        >
                                            {removing ? <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" /> : <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                                            Remove
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
