// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useUnsavedChanges } from '@web/hooks/use-unsaved-changes'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Save, Trash2, AlertTriangle, KeyRound, CreditCard, Link2, Unlink } from 'lucide-react'
import { authClient } from '@web/lib/auth-client'

interface SessionUser {
    id: string
    email: string
    name?: string | null
    image?: string | null
    emailVerified?: boolean
}

export function AccountClient() {
    const router = useRouter()
    const [user, setUser] = useState<SessionUser | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Profile form state
    const [name, setName] = useState('')
    const [image, setImage] = useState('')
    const [savingProfile, setSavingProfile] = useState(false)
    const [profileMsg, setProfileMsg] = useState<string | null>(null)

    // Password form state
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [savingPassword, setSavingPassword] = useState(false)
    const [passwordMsg, setPasswordMsg] = useState<string | null>(null)
    const [passwordErr, setPasswordErr] = useState<string | null>(null)

    const [profileDirty, setProfileDirty] = useState(false)
    useUnsavedChanges(profileDirty)

    // Linked accounts
    const [linkedAccounts, setLinkedAccounts] = useState<{ id: string; providerId: string; accountId?: string }[]>([])
    const [linkingGoogle, setLinkingGoogle] = useState(false)
    const [unlinkingId, setUnlinkingId] = useState<string | null>(null)

    // Danger zone
    const [deleting, setDeleting] = useState(false)
    const [deleteErr, setDeleteErr] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState('')

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const session = await authClient.getSession()
                if (cancelled) return
                const u = session.data?.user as SessionUser | undefined
                if (!u) {
                    router.push('/login')
                    return
                }
                setUser(u)
                setName(u.name ?? '')
                setImage(u.image ?? '')

                // Fetch linked social accounts
                try {
                    const accountsRes = await authClient.listAccounts()
                    if (!cancelled && accountsRes.data) {
                        setLinkedAccounts(accountsRes.data as { id: string; providerId: string; accountId?: string }[])
                    }
                } catch { /* non-fatal — linked accounts section just won't show */ }
            } catch (err) {
                if (!cancelled) setError((err as Error).message || 'Failed to load account')
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        load()
        return () => { cancelled = true }
    }, [router])

    async function saveProfile(e: React.FormEvent) {
        e.preventDefault()
        setSavingProfile(true)
        setProfileMsg(null)
        setError(null)
        try {
            const result = await authClient.updateUser({
                name: name.trim() || undefined,
                image: image.trim() || undefined,
            })
            if ((result as { error?: { message?: string } }).error) {
                setError((result as { error: { message?: string } }).error.message ?? 'Could not update profile')
                setSavingProfile(false)
                return
            }
            setProfileMsg('Saved.')
            setProfileDirty(false)
            setSavingProfile(false)
        } catch (err) {
            setError((err as Error).message || 'Could not update profile')
            setSavingProfile(false)
        }
    }

    async function savePassword(e: React.FormEvent) {
        e.preventDefault()
        setPasswordErr(null)
        setPasswordMsg(null)

        if (newPassword.length < 12) {
            setPasswordErr('Password must be at least 12 characters.')
            return
        }
        if (newPassword !== confirmPassword) {
            setPasswordErr('Passwords do not match.')
            return
        }

        setSavingPassword(true)
        try {
            const result = await authClient.changePassword({
                currentPassword,
                newPassword,
            })
            if ((result as { error?: { message?: string } }).error) {
                setPasswordErr((result as { error: { message?: string } }).error.message ?? 'Password change failed')
                setSavingPassword(false)
                return
            }
            setPasswordMsg('Password updated.')
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
            setSavingPassword(false)
        } catch (err) {
            setPasswordErr((err as Error).message || 'Password change failed')
            setSavingPassword(false)
        }
    }

    async function handleDelete() {
        setDeleteErr(null)
        setDeleting(true)
        try {
            // DI-002: Delete all workspaces owned by this user before removing
            // the auth account, so workspace data doesn't persist as orphans.
            if (user?.id) {
                try {
                    const wsRes = await fetch('/api/v1/workspaces', { cache: 'no-store' })
                    if (wsRes.ok) {
                        const wsData = await wsRes.json()
                        const owned = (wsData.items ?? []).filter((w: { ownerId?: string }) => w.ownerId === user.id)
                        for (const ws of owned) {
                            await fetch(`/api/v1/workspaces/${ws.id}`, { method: 'DELETE' })
                        }
                    }
                } catch (wsErr) {
                    // Non-fatal — workspace cleanup is best-effort on the client.
                    // Server-side cascade should be added as a safety net.
                    console.warn('Failed to clean up owned workspaces before account deletion', wsErr)
                }
            }

            const result = await authClient.deleteUser({ password: confirmDelete })
            if ((result as { error?: { message?: string } }).error) {
                setDeleteErr((result as { error: { message?: string } }).error.message ?? 'Could not delete account')
                setDeleting(false)
                return
            }
            router.push('/login?deleted=true')
        } catch (err) {
            setDeleteErr((err as Error).message || 'Could not delete account')
            setDeleting(false)
        }
    }

    if (loading) {
        return (
            <div className="mx-auto w-full max-w-2xl space-y-8 p-4 sm:p-6">
                <header className="space-y-1">
                    <h1 className="text-xl font-medium tracking-tight text-text-primary">Account</h1>
                </header>
                <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
                </div>
            </div>
        )
    }

    if (!user) {
        return (
            <div className="mx-auto w-full max-w-2xl space-y-8 p-4 sm:p-6">
                <header className="space-y-1">
                    <h1 className="text-xl font-medium tracking-tight text-text-primary">Account</h1>
                </header>
                <div className="p-6 text-sm text-text-primary">Not signed in.</div>
            </div>
        )
    }

    return (
        <div className="mx-auto w-full max-w-2xl space-y-8 p-4 sm:p-6">
            <header className="space-y-1">
                <h1 className="text-xl font-medium tracking-tight text-text-primary">Account</h1>
                <p className="text-sm text-text-muted">Your Joeybuilt identity. Used across every Joeybuilt app.</p>
            </header>

            {error && (
                <div className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                    {error}
                </div>
            )}

            {/* Profile */}
            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <h2 className="mb-4 text-sm font-medium text-text-primary">Profile</h2>
                <form onSubmit={saveProfile} className="space-y-3">
                    <div>
                        <label htmlFor="acct-name" className="mb-1 block text-xs font-medium text-text-muted">Display name</label>
                        <input
                            id="acct-name"
                            type="text"
                            value={name}
                            onChange={(e) => { setName(e.target.value); setProfileDirty(true) }}
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                            placeholder="How you want to be called"
                        />
                    </div>
                    <div>
                        <label htmlFor="acct-email" className="mb-1 block text-xs font-medium text-text-muted">Email</label>
                        <input
                            id="acct-email"
                            type="email"
                            value={user.email}
                            disabled
                            className="w-full cursor-not-allowed rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-muted"
                        />
                        <p className="mt-1 text-[11px] text-text-muted">
                            Email changes are handled separately by Better Auth — contact support if you need to change it.
                            {user.emailVerified === false && ' (Not verified yet — check your inbox for the verification link.)'}
                        </p>
                    </div>
                    <div>
                        <label htmlFor="acct-image" className="mb-1 block text-xs font-medium text-text-muted">Avatar URL</label>
                        <input
                            id="acct-image"
                            type="url"
                            value={image}
                            onChange={(e) => { setImage(e.target.value); setProfileDirty(true) }}
                            placeholder="https://…"
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                        />
                    </div>

                    <div className="flex items-center justify-between pt-2">
                        {profileMsg && <span className="text-xs text-text-muted">{profileMsg}</span>}
                        <button
                            type="submit"
                            disabled={savingProfile}
                            className="ml-auto flex items-center gap-1.5 rounded-sm border border-border bg-text-primary px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
                        >
                            {savingProfile ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Save profile
                        </button>
                    </div>
                </form>
            </section>

            {/* Linked accounts */}
            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Link2 className="h-4 w-4" /> Linked accounts
                </h2>
                {linkedAccounts.some((a) => a.providerId === 'google') ? (
                    <div className="flex items-center justify-between rounded-sm border border-border bg-surface-1 px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                            <svg className="h-4 w-4" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                            <span className="text-sm text-text-primary">Google</span>
                            <span className="rounded bg-text-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">Connected</span>
                        </div>
                        <button
                            type="button"
                            disabled={unlinkingId !== null}
                            onClick={async () => {
                                const googleAccount = linkedAccounts.find((a) => a.providerId === 'google')
                                if (!googleAccount) return
                                setUnlinkingId(googleAccount.id)
                                try {
                                    await authClient.unlinkAccount({ providerId: 'google' })
                                    setLinkedAccounts((prev) => prev.filter((a) => a.providerId !== 'google'))
                                } catch { /* ignore */ }
                                setUnlinkingId(null)
                            }}
                            className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-50"
                        >
                            {unlinkingId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
                            Unlink
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        disabled={linkingGoogle}
                        onClick={async () => {
                            setLinkingGoogle(true)
                            try {
                                await authClient.linkSocial({ provider: 'google', callbackURL: '/app/account' })
                            } catch {
                                setLinkingGoogle(false)
                            }
                        }}
                        className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-border bg-surface-1 px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-text-primary/5 disabled:opacity-50"
                    >
                        {linkingGoogle ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <>
                                <svg className="h-4 w-4" viewBox="0 0 24 24">
                                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                </svg>
                                Link Google account
                            </>
                        )}
                    </button>
                )}
                <p className="mt-2 text-[11px] text-text-muted">
                    Link your Google account for one-click sign in. This is separate from Google Workspace connections in your workspaces.
                </p>
            </section>

            {/* Password */}
            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-text-primary">
                    <KeyRound className="h-4 w-4" /> Change password
                </h2>
                <form onSubmit={savePassword} className="space-y-3">
                    <div>
                        <label htmlFor="acct-current" className="mb-1 block text-xs font-medium text-text-muted">Current password</label>
                        <input
                            id="acct-current"
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                            required
                            autoComplete="current-password"
                        />
                    </div>
                    <div>
                        <label htmlFor="acct-new" className="mb-1 block text-xs font-medium text-text-muted">New password</label>
                        <input
                            id="acct-new"
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                            required
                            minLength={12}
                            autoComplete="new-password"
                        />
                    </div>
                    <div>
                        <label htmlFor="acct-confirm" className="mb-1 block text-xs font-medium text-text-muted">Confirm new password</label>
                        <input
                            id="acct-confirm"
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                            required
                            minLength={12}
                            autoComplete="new-password"
                        />
                    </div>

                    {passwordErr && (
                        <div className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                            {passwordErr}
                        </div>
                    )}

                    <div className="flex items-center justify-between pt-2">
                        {passwordMsg && <span className="text-xs text-text-muted">{passwordMsg}</span>}
                        <button
                            type="submit"
                            disabled={savingPassword}
                            className="ml-auto flex items-center gap-1.5 rounded-sm border border-border bg-text-primary px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
                        >
                            {savingPassword ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                            Update password
                        </button>
                    </div>
                </form>
            </section>

            {/* Subscription link */}
            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-medium text-text-primary">Billing & subscription</h2>
                        <p className="mt-1 text-xs text-text-muted">View your plan and upgrade options.</p>
                    </div>
                    <Link
                        href="/app/account/subscription"
                        className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-primary hover:opacity-90"
                    >
                        <CreditCard className="h-3.5 w-3.5" /> Manage
                    </Link>
                </div>
            </section>

            {/* Danger zone */}
            <section className="rounded-sm border border-border bg-surface-1 p-5">
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
                    <AlertTriangle className="h-4 w-4" /> Danger zone
                </h2>
                <p className="mb-3 text-xs text-text-muted">
                    Deleting your account removes access to every Joeybuilt app that uses this identity. Workspace data you own
                    may be transferred or deleted according to the workspace&apos;s retention rules.
                </p>
                <div className="space-y-3">
                    <div>
                        <label htmlFor="acct-delete-pwd" className="mb-1 block text-xs font-medium text-text-muted">
                            Confirm with your current password
                        </label>
                        <input
                            id="acct-delete-pwd"
                            type="password"
                            value={confirmDelete}
                            onChange={(e) => setConfirmDelete(e.target.value)}
                            className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure/30 focus-ring focus:ring-1 focus:ring-azure/20"
                            placeholder="Current password"
                            autoComplete="current-password"
                        />
                    </div>
                    {deleteErr && (
                        <div className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary" role="alert">
                            {deleteErr}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleting || !confirmDelete}
                        className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-text-primary/5 disabled:opacity-50"
                    >
                        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        Delete my account
                    </button>
                </div>
            </section>
        </div>
    )
}
