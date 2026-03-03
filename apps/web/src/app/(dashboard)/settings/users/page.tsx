'use client'

import { useState, useEffect, useCallback } from 'react'
import {
    Users,
    RefreshCw,
    Shield,
    ShieldCheck,
    Mail,
    Clock,
    ChevronRight,
    Save,
    Check,
    AlertCircle,
} from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRole = 'admin' | 'member'

interface User {
    id: string
    email: string
    name: string | null
    role: UserRole
    createdAt: string
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
    return new Date(iso).toLocaleDateString()
}

function RoleBadge({ role }: { role: UserRole }) {
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${role === 'admin'
                ? 'border-amber-800/50 bg-amber-950/30 text-amber-400'
                : 'border-zinc-700 bg-zinc-800/50 text-zinc-500'
            }`}>
            {role === 'admin' ? <ShieldCheck className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
            {role}
        </span>
    )
}

function initials(name: string | null, email: string): string {
    if (name) return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
    return email[0].toUpperCase()
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
    const [users, setUsers] = useState<User[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<User | null>(null)
    const [editName, setEditName] = useState('')
    const [editRole, setEditRole] = useState<UserRole>('member')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const fetchUsers = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/users`)
            if (res.ok) {
                const data = await res.json() as { items: User[] }
                setUsers(data.items ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchUsers() }, [fetchUsers])

    function selectUser(user: User) {
        setSelected(user)
        setEditName(user.name ?? '')
        setEditRole(user.role)
        setError(null)
        setSaved(false)
    }

    async function handleSave() {
        if (!selected) return
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/users/${selected.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editName || undefined, role: editRole }),
            })
            if (res.ok) {
                setSaved(true)
                setTimeout(() => setSaved(false), 2000)
                setUsers((prev) => prev.map((u) =>
                    u.id === selected.id ? { ...u, name: editName || null, role: editRole } : u
                ))
                setSelected((s) => s ? { ...s, name: editName || null, role: editRole } : s)
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Save failed')
            }
        } finally {
            setSaving(false)
        }
    }

    const adminCount = users.filter((u) => u.role === 'admin').length

    return (
        <div className="flex flex-col gap-6 h-full">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Users</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        {users.length} user{users.length !== 1 ? 's' : ''} · {adminCount} admin{adminCount !== 1 ? 's' : ''}
                    </p>
                </div>
                <button
                    onClick={() => void fetchUsers()}
                    disabled={loading}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Two-panel */}
            <div className="flex gap-4 flex-1 min-h-0">
                {/* Left — user list */}
                <div className="w-[260px] shrink-0 flex flex-col gap-1 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-sm text-zinc-600">
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Loading…
                        </div>
                    ) : users.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-zinc-600">
                            <Users className="h-6 w-6 text-zinc-700" />
                            No users found
                        </div>
                    ) : users.map((user) => {
                        const active = selected?.id === user.id
                        return (
                            <button
                                key={user.id}
                                onClick={() => selectUser(user)}
                                className={`text-left rounded-xl border p-3 transition-all ${active
                                        ? 'border-indigo-500/50 bg-zinc-900'
                                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                                    }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2.5">
                                        {/* Avatar */}
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-bold text-indigo-400 shrink-0">
                                            {initials(user.name, user.email)}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-zinc-200 truncate max-w-[130px]">
                                                {user.name ?? user.email.split('@')[0]}
                                            </p>
                                            <p className="text-[10px] text-zinc-600 truncate max-w-[130px]">{user.email}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <RoleBadge role={user.role} />
                                        {active && <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />}
                                    </div>
                                </div>
                            </button>
                        )
                    })}
                </div>

                {/* Right — user detail / edit */}
                <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-y-auto">
                    {!selected ? (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                                <Users className="mx-auto mb-3 h-8 w-8 text-zinc-700" />
                                <p className="text-sm text-zinc-500">Select a user to view details</p>
                            </div>
                        </div>
                    ) : (
                        <div className="p-5 flex flex-col gap-5">
                            {/* User header */}
                            <div className="flex items-center gap-4 pb-4 border-b border-zinc-800">
                                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/20 text-xl font-bold text-indigo-400">
                                    {initials(selected.name, selected.email)}
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold text-zinc-100">
                                        {selected.name ?? selected.email.split('@')[0]}
                                    </h2>
                                    <div className="flex items-center gap-1.5 mt-1">
                                        <Mail className="h-3.5 w-3.5 text-zinc-600" />
                                        <span className="text-sm text-zinc-500">{selected.email}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <Clock className="h-3.5 w-3.5 text-zinc-600" />
                                        <span className="text-xs text-zinc-600">Joined {timeAgo(selected.createdAt)}</span>
                                    </div>
                                </div>
                                <div className="ml-auto">
                                    <RoleBadge role={selected.role} />
                                </div>
                            </div>

                            {/* Edit fields */}
                            <div className="flex flex-col gap-4">
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-sm font-medium text-zinc-300">Display name</label>
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={(e) => setEditName(e.target.value)}
                                        placeholder={selected.email.split('@')[0]}
                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                    />
                                </div>

                                <div className="flex flex-col gap-1.5">
                                    <label className="text-sm font-medium text-zinc-300">Role</label>
                                    <div className="flex gap-2">
                                        {(['member', 'admin'] as UserRole[]).map((r) => (
                                            <button
                                                key={r}
                                                onClick={() => setEditRole(r)}
                                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all ${editRole === r
                                                        ? 'border-indigo-500/50 bg-indigo-600/10 text-indigo-300'
                                                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'
                                                    }`}
                                            >
                                                {r === 'admin' ? <ShieldCheck className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
                                                <span className="capitalize">{r}</span>
                                            </button>
                                        ))}
                                    </div>
                                    {editRole === 'admin' && (
                                        <p className="text-xs text-amber-500/80">Admins can manage workspace settings, users, and channels.</p>
                                    )}
                                </div>
                            </div>

                            {/* User ID */}
                            <div className="rounded-lg bg-zinc-950 px-3 py-2 flex items-center justify-between">
                                <span className="text-xs text-zinc-600">User ID</span>
                                <span className="font-mono text-[11px] text-zinc-500">{selected.id}</span>
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2.5 text-sm text-red-400">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    {error}
                                </div>
                            )}

                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    onClick={() => void handleSave()}
                                    disabled={saving}
                                    className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                                >
                                    {saving
                                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                        : saved
                                            ? <Check className="h-3.5 w-3.5 text-emerald-400" />
                                            : <Save className="h-3.5 w-3.5" />
                                    }
                                    {saved ? 'Saved' : 'Save changes'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
