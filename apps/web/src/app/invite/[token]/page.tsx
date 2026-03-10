// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, XCircle, Clock, RefreshCw, Shield } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface InviteInfo {
    workspaceId: string
    workspaceName: string
    role: string
    invitedEmail: string | null
    expiresAt: string
}

type Status = 'loading' | 'ready' | 'accepting' | 'done' | 'error'

export default function InvitePage() {
    const { token } = useParams() as { token: string }
    const router = useRouter()

    const [info, setInfo] = useState<InviteInfo | null>(null)
    const [status, setStatus] = useState<Status>('loading')
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch(`${API_BASE}/api/v1/invites/${token}`)
                if (res.ok) {
                    setInfo(await res.json() as InviteInfo)
                    setStatus('ready')
                } else {
                    const d = await res.json() as { error?: { code?: string; message?: string } }
                    setErrorMsg(d.error?.message ?? 'Invalid invite')
                    setStatus('error')
                }
            } catch {
                setErrorMsg('Could not reach server')
                setStatus('error')
            }
        }
        void load()
    }, [token])

    async function accept() {
        setStatus('accepting')
        try {
            // Resolve current user — fetch first user as fallback until auth is wired
            const usersRes = await fetch(`${API_BASE}/api/v1/users`)
            const usersData = await usersRes.json() as { items: { id: string }[] }
            const userId = usersData.items?.[0]?.id
            if (!userId) {
                setErrorMsg('No user account found. Please sign in first.')
                setStatus('error')
                return
            }

            const res = await fetch(`${API_BASE}/api/v1/invites/${token}/accept`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            })

            if (res.ok) {
                setStatus('done')
                setTimeout(() => void router.push('/'), 2500)
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setErrorMsg(d.error?.message ?? 'Accept failed')
                setStatus('error')
            }
        } catch {
            setErrorMsg('Network error')
            setStatus('error')
        }
    }

    return (
        <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-1 p-8 flex flex-col gap-5">
                {/* Logo / brand */}
                <div className="flex items-center gap-2 justify-center mb-2">
                    <div className="h-8 w-8 flex items-center justify-center">
                        <PlexoMark className="h-6 w-6 text-azure drop-shadow-lg" />
                    </div>
                    <span className="font-semibold text-text-primary text-lg">Plexo</span>
                </div>

                {status === 'loading' && (
                    <div className="flex flex-col items-center gap-3 py-4">
                        <RefreshCw className="h-6 w-6 animate-spin text-text-muted" />
                        <p className="text-sm text-text-muted">Checking invite…</p>
                    </div>
                )}

                {status === 'ready' && info && (
                    <>
                        <div className="text-center flex flex-col gap-1">
                            <p className="text-sm text-text-muted">You&apos;ve been invited to join</p>
                            <h1 className="text-xl font-bold text-zinc-50">{info.workspaceName}</h1>
                            <div className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-text-secondary">
                                <Shield className="h-3 w-3" />
                                as <span className="font-semibold text-text-primary capitalize">{info.role}</span>
                            </div>
                        </div>

                        {info.invitedEmail && (
                            <p className="text-center text-xs text-text-muted">
                                This invite is addressed to <span className="text-text-secondary">{info.invitedEmail}</span>
                            </p>
                        )}

                        <div className="flex items-center gap-1.5 justify-center text-xs text-text-muted">
                            <Clock className="h-3 w-3" />
                            Expires {new Date(info.expiresAt).toLocaleDateString()}
                        </div>

                        <button
                            onClick={() => void accept()}
                            className="flex items-center justify-center gap-2 rounded-xl bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors"
                        >
                            Accept invitation
                        </button>
                    </>
                )}

                {status === 'accepting' && (
                    <div className="flex flex-col items-center gap-3 py-4">
                        <RefreshCw className="h-6 w-6 animate-spin text-azure" />
                        <p className="text-sm text-text-secondary">Joining workspace…</p>
                    </div>
                )}

                {status === 'done' && (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <CheckCircle className="h-8 w-8 text-azure" />
                        <div>
                            <p className="text-base font-semibold text-text-primary">You&apos;re in!</p>
                            <p className="text-sm text-text-muted mt-1">Redirecting to your workspace…</p>
                        </div>
                    </div>
                )}

                {status === 'error' && (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <XCircle className="h-8 w-8 text-red" />
                        <div>
                            <p className="text-base font-semibold text-text-primary">Invite invalid</p>
                            <p className="text-sm text-text-muted mt-1">{errorMsg}</p>
                        </div>
                        <Link href="/" className="mt-2 text-sm text-azure hover:text-azure transition-colors">
                            Go to dashboard →
                        </Link>
                    </div>
                )}
            </div>
        </div>
    )
}
