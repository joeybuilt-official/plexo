// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Key, Globe, Save, Check, AlertCircle, Plus, Loader2, LogIn, LogOut, Server, Terminal, Puzzle, Copy, Activity, Trash2, ShieldCheck, Lock } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { AccountabilityPanel } from './accountability-panel'
import { AppearanceSection } from '@web/components/theme-toggle'
import { createClient } from '@web/lib/supabase/client'

interface Section {
    id: string
    label: string
    icon: React.ElementType
    nativeOnly?: boolean
}

const SECTIONS: Section[] = [
    { id: 'account', label: 'Account', icon: Lock },
    { id: 'workspace', label: 'Workspace', icon: Globe },
    { id: 'api-keys', label: 'API Keys', icon: Key },
    { id: 'api', label: 'REST API', icon: Server },
    { id: 'cli', label: 'CLI', icon: Terminal },
    { id: 'mcp', label: 'MCP', icon: Puzzle },
    { id: 'accountability', label: 'Accountability', icon: ShieldCheck },
    { id: 'appearance', label: 'Appearance', icon: Activity },
    { id: 'about', label: 'About', icon: Activity },
    { id: 'app', label: 'App Settings', icon: LogIn, nativeOnly: true },
]
import { getRuntimeContext } from '@plexo/ui/lib/runtime'
import { Preferences } from '@capacitor/preferences'
function CodeSnippet({ label, code }: { label?: string; code: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        void navigator.clipboard.writeText(code)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="flex flex-col gap-1.5">
            {label && <p className="text-[11px] uppercase tracking-widest text-text-muted font-medium">{label}</p>}
            <div className="relative group">
                <code className="block rounded-lg bg-canvas border border-border/80 p-3 pr-10 text-[11px] font-mono text-text-secondary whitespace-pre overflow-x-auto leading-relaxed max-h-[400px]">
                    {code}
                </code>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="absolute right-2 top-2 p-1.5 rounded-md bg-surface-2/80 text-text-secondary opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-primary hover:bg-zinc-700 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                    title="Copy code"
                >
                    {copied ? <Check className="h-3.5 w-3.5 text-azure" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
            </div>
        </div>
    )
}

function Field({ label, id, description, children }: { label: string; id: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
            {children}
            {description && <p className="text-xs text-text-muted">{description}</p>}
        </div>
    )
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 disabled:opacity-50 min-h-[44px] md:min-h-[36px]"
        />
    )
}



function SaveButton({ saved, saving }: { saved: boolean; saving: boolean }) {
    return (
        <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-lg bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50 min-h-[44px] md:min-h-[36px] w-full md:w-auto"
        >
            {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
    )
}

interface WorkspaceRow {
    id: string
    name: string
    createdAt: string
}

export default function SettingsPage() {
    const { workspaceId, setWorkspace } = useWorkspace()
    const [active, setActive] = useState('workspace')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
    // Active workspace ID — prefer context (localStorage), fall back to env
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    // Workspace settings state
    const [workspaceName, setWorkspaceName] = useState('My Workspace')
    const [costCeiling, setCostCeiling] = useState('10')

    // Workspace list state
    const [wsList, setWsList] = useState<WorkspaceRow[]>([])
    const [wsListLoading, setWsListLoading] = useState(false)
    const [creatingWs, setCreatingWs] = useState(false)
    const [newWsName, setNewWsName] = useState('')
    const [creating, setCreating] = useState(false)
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
    const [deletingWs, setDeletingWs] = useState(false)

    const loadWorkspaceList = useCallback(async () => {
        setWsListLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces`, { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json() as { items?: WorkspaceRow[] }
            setWsList(data.items ?? [])
        } catch { /* non-fatal */ } finally { setWsListLoading(false) }
    }, [API_BASE])

    // Load workspace data on mount
    const loadWorkspace = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}`)
            if (!res.ok) return
            const data = await res.json() as { name: string; settings?: Record<string, unknown> }
            if (data.name) setWorkspaceName(data.name)
            const s = data.settings ?? {}
            if (typeof s.costCeilingUsdWeekly === 'number') setCostCeiling(String(s.costCeilingUsdWeekly))
        } catch { /* non-fatal */ }
    }, [API_BASE, WS_ID])

    useEffect(() => { void loadWorkspace() }, [loadWorkspace])
    useEffect(() => { if (active === 'workspace') void loadWorkspaceList() }, [active, loadWorkspaceList])

    // Password change state
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [pwSaving, setPwSaving] = useState(false)
    const [pwSuccess, setPwSuccess] = useState(false)
    const [pwError, setPwError] = useState<string | null>(null)

    async function handlePasswordChange(e: React.FormEvent) {
        e.preventDefault()
        setPwError(null)
        setPwSuccess(false)

        if (newPassword.length < 8) {
            setPwError('Password must be at least 8 characters')
            return
        }
        if (newPassword !== confirmPassword) {
            setPwError('Passwords do not match')
            return
        }

        setPwSaving(true)
        try {
            const supabase = createClient()
            const { error } = await supabase.auth.updateUser({ password: newPassword })
            if (error) throw new Error(error.message)
            setPwSuccess(true)
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
            setTimeout(() => setPwSuccess(false), 4000)
        } catch (err: unknown) {
            setPwError(err instanceof Error ? err.message : 'Failed to update password')
        } finally {
            setPwSaving(false)
        }
    }

    // Health state
    const [health, setHealth] = useState<{ version?: string; uptime?: number; status?: string } | null>(null)
    useEffect(() => {
        if (active !== 'about') return
        fetch(`${API_BASE}/health`)
            .then(res => res.json())
            .then(data => setHealth(data))
            .catch(() => { })
    }, [active, API_BASE])

    // Instance API Keys State
    const [apiKeys, setApiKeys] = useState<{ id: string; name: string; createdAt: string; token?: string }[]>([])
    const [keysLoading, setKeysLoading] = useState(false)
    const [creatingApiKey, setCreatingApiKey] = useState(false)
    const [newApiKeyName, setNewApiKeyName] = useState('')
    const [creatingKey, setCreatingKey] = useState(false)

    const loadApiKeys = useCallback(async () => {
        if (!WS_ID) return
        setKeysLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/api-keys`)
            if (res.ok) {
                const data = await res.json() as { items?: { id: string; name: string; createdAt: string }[] }
                setApiKeys(data.items ?? [])
            }
        } catch { /* non-fatal */ } finally { setKeysLoading(false) }
    }, [API_BASE, WS_ID])

    useEffect(() => {
        if (active === 'api-keys' || active === 'system') void loadApiKeys()
    }, [active, loadApiKeys])

    // API key state (write-only — never read back)
    const [openaiKey, setOpenaiKey] = useState('')

    async function handleDeleteWorkspace(id: string) {
        setDeletingWs(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${id}`, { method: 'DELETE' })
            if (res.ok) {
                setWsList(prev => prev.filter(ws => ws.id !== id))
                setConfirmDeleteId(null)
            }
        } catch { /* non-fatal */ } finally { setDeletingWs(false) }
    }

    async function handleCreateWorkspace() {
        if (!newWsName.trim()) return
        setCreating(true)
        try {
            // Get ownerId from current workspace
            const wsRes = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}`)
            const wsData = await (wsRes.ok ? wsRes.json() : {}) as { ownerId?: string }
            const ownerId = wsData.ownerId ?? WS_ID
            const res = await fetch(`${API_BASE}/api/v1/workspaces`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newWsName.trim(), ownerId }),
            })
            if (res.ok) {
                const created = await res.json() as WorkspaceRow
                setWsList((prev) => [created, ...prev])
                setNewWsName('')
                setCreatingWs(false)
            }
        } catch { /* non-fatal */ } finally { setCreating(false) }
    }

    async function handleCreateApiKey() {
        if (!newApiKeyName.trim()) return
        setCreatingKey(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/api-keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newApiKeyName.trim(), scopes: [] }),
            })
            if (res.ok) {
                const created = await res.json() as { id: string; name: string; createdAt: string; token: string }
                setApiKeys(prev => [created, ...prev])
                setNewApiKeyName('')
                setCreatingApiKey(false)
            }
        } catch { /* non-fatal */ } finally { setCreatingKey(false) }
    }

    async function handleRevokeApiKey(id: string) {
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/api-keys/${id}`, { method: 'DELETE' })
            if (res.ok) {
                setApiKeys(prev => prev.filter(k => k.id !== id))
            }
        } catch { /* non-fatal */ }
    }

    async function handleSave(e: React.FormEvent) {
        e.preventDefault()
        setSaving(true)
        setSaveError(null)
        try {
            if (active === 'workspace') {
                // Merge changes into workspace settings
                const payload = { name: workspaceName, settings: { costCeilingUsdWeekly: parseFloat(costCeiling) || 10 } }
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                if (!res.ok) {
                    const err = await res.json() as { error?: { message?: string } }
                    throw new Error(err.error?.message ?? 'Save failed')
                }
            } else if (active === 'api-keys') {
                // Store non-empty keys into workspace settings (API encrypts at rest)
                const apiKeys: Record<string, string> = {}
                if (openaiKey.trim()) apiKeys.openai = openaiKey.trim()
                if (Object.keys(apiKeys).length > 0) {
                    const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ settings: { apiKeys } }),
                    })
                    if (!res.ok) throw new Error('Failed to save keys')
                }
                setOpenaiKey('')
            }
            setSaved(true)
            setTimeout(() => setSaved(false), 3000)
        } catch (err: unknown) {
            setSaveError(err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="flex flex-col md:flex-row gap-4 md:gap-8 max-w-4xl">
            {/* Sidebar nav */}
            <nav className="shrink-0 w-full md:w-44 overflow-x-auto pb-2 md:pb-0 scrollbar-none">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-text-muted hidden md:block">Settings</p>
                <div className="flex flex-row md:flex-col gap-1.5 md:gap-0.5 min-w-max md:min-w-0">
                    {SECTIONS.filter(s =>
                        !s.nativeOnly || (typeof window !== 'undefined' && getRuntimeContext() !== 'browser')
                    ).map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setActive(id)}
                            className={`flex items-center gap-2.5 rounded-lg px-4 md:px-3 py-2.5 md:py-2 text-sm text-left transition-colors min-h-[44px] md:min-h-[32px] ${active === id ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary'}`}
                        >
                            <Icon className={`h-4 w-4 shrink-0 ${active === id ? 'text-azure' : 'text-text-muted'}`} />
                            {label}
                        </button>
                    ))}
                </div>
            </nav>

            {/* Content */}
            <form onSubmit={handleSave} className="flex-1 flex flex-col gap-4">
                {saveError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2.5 text-sm text-red">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        {saveError}
                    </div>
                )}
                {active === 'account' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Account</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Manage your account security.</p>
                        </div>

                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-azure-dim text-azure">
                                    <Lock className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">Change Password</h3>
                                    <p className="text-[11px] text-text-muted">Update your login password</p>
                                </div>
                            </div>

                            {pwError && (
                                <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2.5 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                    {pwError}
                                </div>
                            )}
                            {pwSuccess && (
                                <div className="flex items-start gap-2 rounded-lg border border-azure/30 bg-azure/5 px-3 py-2.5 text-sm text-azure">
                                    <Check className="h-4 w-4 shrink-0 mt-0.5" />
                                    Password updated successfully.
                                </div>
                            )}

                            <div className="flex flex-col gap-3">
                                <Field label="New password" id="new-password">
                                    <input
                                        id="new-password"
                                        type="password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        placeholder="Min. 8 characters"
                                        autoComplete="new-password"
                                        className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 min-h-[44px] md:min-h-[36px]"
                                    />
                                </Field>
                                <Field label="Confirm new password" id="confirm-password">
                                    <input
                                        id="confirm-password"
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder="Re-enter new password"
                                        autoComplete="new-password"
                                        className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 min-h-[44px] md:min-h-[36px]"
                                    />
                                </Field>
                                <button
                                    type="button"
                                    onClick={handlePasswordChange}
                                    disabled={pwSaving || !newPassword || !confirmPassword}
                                    className="flex items-center justify-center gap-2 rounded-lg bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50 min-h-[44px] md:min-h-[36px] w-full md:w-auto"
                                >
                                    {pwSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : pwSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                                    {pwSaving ? 'Updating...' : pwSuccess ? 'Updated' : 'Update password'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {active === 'workspace' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Workspace</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Manage your workspaces and configure the active one</p>
                        </div>

                        {/* Active workspace config */}
                        <div className="rounded-xl border border-border bg-surface-1/40 p-4 sm:p-5 flex flex-col gap-4 sm:gap-5">
                            <p className="text-[11px] uppercase tracking-widest text-text-muted font-medium">Active workspace</p>
                            <Field id="workspace-name" label="Workspace name" description="Displayed in the sidebar and agent context.">
                                <Input id="workspace-name" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="My Workspace" />
                            </Field>
                            <Field id="workspace-id" label="Workspace ID" description="Read-only — used in API calls and env vars.">
                                <Input id="workspace-id" value={WS_ID} readOnly className="font-mono text-xs opacity-50 cursor-default" />
                            </Field>
                            <Field id="cost-ceiling" label="Weekly cost ceiling (USD)" description="Agent stops queueing new tasks when the weekly API cost exceeds this amount. Alert fires at 80%.">
                                <Input id="cost-ceiling" type="number" min="1" step="1" value={costCeiling} onChange={(e) => setCostCeiling(e.target.value)} />
                            </Field>
                        </div>
                        <div className="flex justify-end">
                            <SaveButton saved={saved} saving={saving} />
                        </div>

                        {/* All workspaces */}
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <p className="text-[11px] uppercase tracking-widest text-text-muted font-medium">All workspaces</p>
                                <button
                                    type="button"
                                    onClick={() => setCreatingWs((v) => !v)}
                                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 md:px-2.5 py-2 md:py-1.5 min-h-[44px] md:min-h-[32px] text-sm md:text-[12px] text-text-secondary hover:border-azure-600/50 hover:text-azure transition-colors"
                                >
                                    <Plus className="h-4 w-4 md:h-3.5 md:w-3.5" />
                                    New workspace
                                </button>
                            </div>

                            {creatingWs && (
                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-2 rounded-xl border border-azure-800/40 bg-azure/20 px-4 py-3">
                                    <input
                                        autoFocus
                                        value={newWsName}
                                        onChange={(e) => setNewWsName(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') void handleCreateWorkspace()
                                            if (e.key === 'Escape') { setCreatingWs(false); setNewWsName('') }
                                        }}
                                        placeholder="Workspace name"
                                        className="flex-1 bg-transparent text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none min-h-[44px] sm:min-h-[32px]"
                                    />
                                    <div className="flex gap-2 justify-end">
                                        <button
                                            type="button"
                                            onClick={() => void handleCreateWorkspace()}
                                            disabled={creating || !newWsName.trim()}
                                            className="flex items-center justify-center gap-1 rounded-lg bg-azure px-4 sm:px-3 py-2 sm:py-1.5 min-h-[44px] sm:min-h-0 text-sm sm:text-[12px] font-semibold text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors flex-1 sm:flex-none"
                                        >
                                            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                            Create
                                        </button>
                                        <button type="button" onClick={() => { setCreatingWs(false); setNewWsName('') }} className="text-text-muted hover:text-text-secondary text-sm transition-colors min-h-[44px] sm:min-h-0 px-2 flex-1 sm:flex-none text-center">Cancel</button>
                                    </div>
                                </div>
                            )}

                            <div className="rounded-xl border border-border overflow-hidden">
                                {wsListLoading ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                                    </div>
                                ) : wsList.length === 0 ? (
                                    <p className="px-4 py-6 text-sm text-text-muted text-center">No workspaces found</p>
                                ) : (
                                    wsList.map((ws, i) => {
                                        const isActive = ws.id === WS_ID
                                        return (
                                            <div
                                                key={ws.id}
                                                className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''} ${isActive ? 'bg-azure/20' : 'hover:bg-surface-1/40'} transition-colors`}
                                            >
                                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-azure/20 text-[11px] font-bold text-azure">
                                                    {ws.name.slice(0, 1).toUpperCase()}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-text-primary truncate">{ws.name}</p>
                                                    <p className="text-[10px] font-mono text-text-muted truncate">{ws.id}</p>
                                                </div>
                                                {isActive ? (
                                                    <span className="flex items-center gap-1 rounded-full bg-azure-900/40 border border-azure-700/30 px-2 py-0.5 text-[10px] sm:text-xs font-medium text-azure shrink-0">
                                                        <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3 shrink-0" />
                                                        Active
                                                    </span>
                                                ) : confirmDeleteId === ws.id ? (
                                                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-1.5 shrink-0">
                                                        <span className="text-[11px] text-red hidden sm:inline">Delete?</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleDeleteWorkspace(ws.id)}
                                                            disabled={deletingWs}
                                                            className="flex items-center justify-center gap-1 rounded-lg bg-red-700/80 px-3 sm:px-2.5 py-1.5 sm:py-1 min-h-[44px] sm:min-h-[32px] text-sm sm:text-[11px] font-medium text-text-primary hover:bg-red-600 disabled:opacity-50 transition-colors"
                                                        >
                                                            {deletingWs ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                                            Confirm
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setConfirmDeleteId(null)}
                                                            className="flex items-center justify-center text-text-muted hover:text-text-secondary text-sm sm:text-[11px] transition-colors min-h-[44px] sm:min-h-[32px] px-2"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-1.5 shrink-0">
                                                        <button
                                                            type="button"
                                                            onClick={() => setWorkspace(ws.id, ws.name)}
                                                            className="flex items-center justify-center gap-1 rounded-lg border border-border px-3 sm:px-2.5 py-2 sm:py-1 min-h-[44px] sm:min-h-[32px] text-sm sm:text-[11px] text-text-secondary hover:border-azure-600/50 hover:text-azure transition-colors"
                                                        >
                                                            <LogIn className="h-4 w-4 sm:h-3 sm:w-3 shrink-0" />
                                                            Switch
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setConfirmDeleteId(ws.id)}
                                                            className="flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-[32px] sm:min-h-[32px] sm:p-1.5 text-text-muted hover:text-red hover:bg-red-dim rounded-lg transition-colors"
                                                            title="Delete workspace"
                                                        >
                                                            <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 shrink-0" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {active === 'api-keys' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">API Keys</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Configure credentials for AI providers.</p>
                        </div>
                        <div className="rounded-xl border border-border bg-surface-1/40 p-6 flex flex-col gap-4">
                            <div className="flex items-start gap-3 rounded-lg border border-azure-800/40 bg-azure/20 px-4 py-3">
                                <AlertCircle className="h-4 w-4 shrink-0 text-azure mt-0.5" />
                                <div>
                                    <p className="text-sm text-azure font-medium">Manage keys in AI Providers</p>
                                    <p className="mt-1 text-xs text-azure/70">
                                        API keys, model selection, provider testing, and the fallback chain are all managed in the dedicated AI Providers page.
                                    </p>
                                    <a
                                        href="/settings/ai-providers"
                                        className="mt-2 inline-flex items-center gap-1 text-sm sm:text-xs font-medium text-azure hover:text-azure transition-colors min-h-[44px] px-2 -mx-2 sm:min-h-0 sm:px-0 sm:mx-0 w-fit"
                                    >
                                        Go to AI Providers →
                                    </a>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-border">
                                <p className="text-xs font-medium text-text-secondary mb-2">Self-hosted environment variables</p>
                                <code className="block rounded-lg bg-canvas border border-border p-3 text-[11px] font-mono text-text-secondary whitespace-pre leading-relaxed">
                                    {`OPENAI_API_KEY=sk-…
OPENROUTER_API_KEY=sk-or-v1-…
GROQ_API_KEY=gsk_…`}
                                </code>
                                <p className="mt-2 text-[10px] text-zinc-700">Set these in <code className="text-text-muted">.env.local</code> or your deployment environment.</p>
                            </div>
                        </div>

                        {/* Instance API Keys */}
                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2.5 mb-1">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-pink-500/10 text-pink-400">
                                        <Key className="h-3.5 w-3.5" />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-semibold text-text-primary">Instance API Keys</h3>
                                        <p className="text-[11px] text-text-muted">Create keys to access the Plexo API programmatically</p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setCreatingApiKey((v) => !v)}
                                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 md:px-2.5 py-2 md:py-1.5 min-h-[44px] md:min-h-0 text-sm md:text-[12px] text-text-secondary hover:border-azure-600/50 hover:text-azure transition-colors"
                                >
                                    <Plus className="h-4 w-4 md:h-3.5 md:w-3.5" />
                                    <span className="hidden sm:inline">New API Key</span>
                                    <span className="sm:hidden">New Key</span>
                                </button>
                            </div>

                            {creatingApiKey && (
                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-2 rounded-xl border border-azure-800/40 bg-azure/20 px-4 py-3 mt-1">
                                    <input
                                        autoFocus
                                        value={newApiKeyName}
                                        onChange={(e) => setNewApiKeyName(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') { e.preventDefault(); void handleCreateApiKey() }
                                            if (e.key === 'Escape') { setCreatingApiKey(false); setNewApiKeyName('') }
                                        }}
                                        placeholder="API Key Name (e.g. CLI Token)"
                                        className="flex-1 bg-transparent text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none min-h-[44px] sm:min-h-0"
                                    />
                                    <div className="flex gap-2 justify-end">
                                            <button
                                                type="button"
                                                onClick={() => void handleCreateApiKey()}
                                                disabled={creatingKey || !newApiKeyName.trim()}
                                                className="flex flex-1 sm:flex-none items-center justify-center gap-1 rounded-lg bg-azure px-4 sm:px-3 py-2 sm:py-1.5 min-h-[44px] sm:min-h-[32px] text-sm sm:text-[12px] font-semibold text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors"
                                            >
                                            {creatingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                            Create
                                        </button>
                                        <button type="button" onClick={() => { setCreatingApiKey(false); setNewApiKeyName('') }} className="flex-1 sm:flex-none text-text-muted hover:text-text-secondary text-sm transition-colors min-h-[44px] sm:min-h-[32px] px-2">Cancel</button>
                                    </div>
                                </div>
                            )}

                            <div className="rounded-xl border border-border overflow-hidden mt-1">
                                {keysLoading ? (
                                    <div className="flex items-center justify-center py-6">
                                        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                                    </div>
                                ) : apiKeys.length === 0 ? (
                                    <p className="px-4 py-6 text-sm text-text-muted text-center">No API keys found</p>
                                ) : (
                                    <div className="flex flex-col">
                                        {apiKeys.map((key) => (
                                            <div key={key.id} className="flex flex-col border-b border-border-subtle last:border-0">
                                                <div className="flex items-center justify-between px-4 py-3 bg-surface-1/20 hover:bg-surface-1/40 transition-colors">
                                                    <div>
                                                        <p className="text-sm font-medium text-text-primary">{key.name}</p>
                                                        <p className="text-[10px] text-text-muted">Created {new Date(key.createdAt).toLocaleDateString()}</p>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleRevokeApiKey(key.id)}
                                                        className="flex min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 items-center justify-center p-2 sm:p-1.5 text-text-muted hover:text-red hover:bg-red-dim rounded-lg transition-colors"
                                                        title="Revoke and delete key"
                                                    >
                                                        <Trash2 className="h-5 w-5 sm:h-4 sm:w-4" />
                                                    </button>
                                                </div>
                                                {key.token && (
                                                    <div className="px-4 pb-4 pt-1">
                                                        <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-3 py-2.5 mb-2">
                                                            <div className="flex items-start gap-2">
                                                                <AlertCircle className="h-4 w-4 shrink-0 text-yellow-500 mt-0.5" />
                                                                <p className="text-xs text-yellow-500 font-medium">Please copy your API key now. You won&apos;t be able to see it again!</p>
                                                            </div>
                                                        </div>
                                                        <CodeSnippet code={key.token} />
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>
                )}

                {active === 'api' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">REST API</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Interact programmatically with this Plexo instance.</p>
                        </div>
                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                                    <Server className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">REST API Configuration</h3>
                                    <p className="text-[11px] text-text-muted">Base configuration and authentication</p>
                                </div>
                            </div>
                            <div className="flex flex-col gap-4">
                                <CodeSnippet label="Base URL" code={API_BASE} />
                                <CodeSnippet
                                    label="Authentication (cURL Example)"
                                    code={`curl -X GET ${API_BASE}/api/v1/workspaces \\
  -H "Authorization: Bearer YOUR_PLEXO_API_KEY"`}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {active === 'cli' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Command Line Interface</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Manage tasks and workspaces from your terminal.</p>
                        </div>
                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-azure-dim text-azure">
                                    <Terminal className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">Plexo CLI</h3>
                                    <p className="text-[11px] text-text-muted">Global installation and login command</p>
                                </div>
                            </div>
                            <div className="flex flex-col gap-4">
                                <CodeSnippet label="Install Node Package" code={`npm install -g @plexo/cli`} />
                                <CodeSnippet label="Authenticate with Instance" code={`plexo login --url ${API_BASE}`} />
                            </div>
                        </div>
                    </div>
                )}

                {active === 'mcp' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Model Context Protocol</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Connect Cursor, Claude Desktop, or Windsurf directly to this instance.</p>
                        </div>
                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber/10 text-orange-400">
                                    <Puzzle className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">MCP Configuration</h3>
                                    <p className="text-[11px] text-text-muted">Using the npx runtime</p>
                                </div>
                            </div>
                            <div className="flex flex-col gap-3">
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Add the following snippet to your <code className="text-text-primary font-mono text-[10px] bg-surface-2 px-1 py-0.5 rounded">claude_desktop_config.json</code> or your IDE&apos;s MCP configuration settings.
                                </p>
                                <CodeSnippet
                                    label="Configuration JSON"
                                    code={`"mcpServers": {
  "plexo": {
    "command": "npx",
    "args": ["-y", "@plexo/mcp"],
    "env": {
      "PLEXO_URL": "${API_BASE}",
      "PLEXO_API_KEY": "YOUR_PLEXO_API_KEY",
      "PLEXO_WORKSPACE_ID": "${WS_ID}"
    }
  }
}`}
                                />
                                <div className="rounded-lg border border-border bg-canvas/50 p-3">
                                    <p className="text-[10px] uppercase tracking-widest text-text-muted font-medium mb-2">Available Tools (8)</p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-4">
                                        {[
                                            { name: 'plexo_health', desc: 'Check system health (no auth)' },
                                            { name: 'plexo_workspace_info', desc: 'Stats & costs (system:read)' },
                                            { name: 'plexo_list_tasks', desc: 'List recent tasks (tasks:read)' },
                                            { name: 'plexo_create_task', desc: 'Queue a task (tasks:write)' },
                                            { name: 'plexo_get_task', desc: 'Get task by ID (tasks:read)' },
                                            { name: 'plexo_cancel_task', desc: 'Cancel a task (tasks:write)' },
                                            { name: 'plexo_search_memory', desc: 'Search memory (memory:read)' },
                                            { name: 'plexo_remember', desc: 'Store memory (memory:write)' },
                                        ].map((t) => (
                                            <div key={t.name} className="flex items-start gap-2 py-0.5">
                                                <code className="text-[10px] text-azure font-mono shrink-0">{t.name}</code>
                                                <span className="text-[10px] text-text-muted">{t.desc}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-zinc-700 mt-2 pt-2 border-t border-border">Resources: <code className="text-text-muted font-mono">workspace://tasks/recent</code> · <code className="text-text-muted font-mono">workspace://memory/recent</code> · <code className="text-text-muted font-mono">workspace://stats</code></p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {active === 'accountability' && <AccountabilityPanel />}

                {active === 'appearance' && <AppearanceSection />}

                {active === 'about' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">About</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Instance health, version, and update status.</p>
                        </div>

                        {/* Instance Health */}
                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-azure-dim text-azure">
                                    <Activity className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">Instance Status</h3>
                                    <p className="text-[11px] text-text-muted">Real-time health of the Plexo backend</p>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="rounded-lg border border-border/80 bg-canvas/50 p-3">
                                    <p className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Status</p>
                                    <div className="flex items-center gap-2">
                                        <div className={`flex h-2 w-2 items-center justify-center rounded-full ${health?.status === 'ok' ? 'bg-azure/20' : 'bg-red/20'}`}>
                                            <div className={`h-1.5 w-1.5 rounded-full ${health?.status === 'ok' ? 'bg-azure' : 'bg-red'}`} />
                                        </div>
                                        <span className="text-xs font-medium text-text-primary">{health?.status === 'ok' ? 'Healthy' : health?.status ? 'Degraded' : 'Unknown'}</span>
                                    </div>
                                </div>
                                <div className="rounded-lg border border-border/80 bg-canvas/50 p-3">
                                    <p className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Version</p>
                                    <p className="text-xs font-mono text-text-primary">{health?.version || '...'}</p>
                                </div>
                                <div className="rounded-lg border border-border/80 bg-canvas/50 p-3">
                                    <p className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Uptime</p>
                                    <p className="text-xs font-mono text-text-primary">{health?.uptime ? `${Math.floor(health.uptime / 60)}m` : '...'}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                {active === 'app' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">App Settings</h2>
                            <p className="mt-0.5 text-sm text-text-muted">Configure your local device app connection.</p>
                        </div>

                        <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-2.5 mb-1">
                                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-dim text-red">
                                    <Globe className="h-3.5 w-3.5" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-text-primary">Connection Mode</h3>
                                    <p className="text-[11px] text-text-muted">Change which Plexo instance this app connects to.</p>
                                </div>
                            </div>
                            <div className="rounded-lg border border-red-800/80 bg-red-950/20 p-4">
                                <p className="text-sm text-red-200 mb-3">
                                    Switching connection modes will disconnect you from this instance and return you to the initial setup screen. You will need to sign in again.
                                </p>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        if (!confirm('Are you sure you want to disconnect?')) return
                                        try {
                                            await Preferences.remove({ key: 'plexo_instance_url' })
                                            window.location.href = '/onboarding?step=1'
                                        } catch {
                                            window.location.href = '/onboarding?step=1'
                                        }
                                    }}
                                    className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-text-primary hover:bg-red transition-colors w-full sm:w-auto justify-center"
                                >
                                    <LogOut className="h-4 w-4" />
                                    Switch Connection
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </form>
        </div>
    )
}
