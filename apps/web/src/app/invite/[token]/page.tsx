// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, XCircle, Clock, RefreshCw, Shield } from 'lucide-react'

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
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-8 flex flex-col gap-5">
                {/* Logo / brand */}
                <div className="flex items-center gap-2 justify-center mb-2">
                    <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">P</div>
                    <span className="font-semibold text-zinc-200 text-lg">Plexo</span>
                </div>

                {status === 'loading' && (
                    <div className="flex flex-col items-center gap-3 py-4">
                        <RefreshCw className="h-6 w-6 animate-spin text-zinc-600" />
                        <p className="text-sm text-zinc-500">Checking invite…</p>
                    </div>
                )}

                {status === 'ready' && info && (
                    <>
                        <div className="text-center flex flex-col gap-1">
                            <p className="text-sm text-zinc-500">You&apos;ve been invited to join</p>
                            <h1 className="text-xl font-bold text-zinc-50">{info.workspaceName}</h1>
                            <div className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
                                <Shield className="h-3 w-3" />
                                as <span className="font-semibold text-zinc-200 capitalize">{info.role}</span>
                            </div>
                        </div>

                        {info.invitedEmail && (
                            <p className="text-center text-xs text-zinc-600">
                                This invite is addressed to <span className="text-zinc-400">{info.invitedEmail}</span>
                            </p>
                        )}

                        <div className="flex items-center gap-1.5 justify-center text-xs text-zinc-600">
                            <Clock className="h-3 w-3" />
                            Expires {new Date(info.expiresAt).toLocaleDateString()}
                        </div>

                        <button
                            onClick={() => void accept()}
                            className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
                        >
                            Accept invitation
                        </button>
                    </>
                )}

                {status === 'accepting' && (
                    <div className="flex flex-col items-center gap-3 py-4">
                        <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
                        <p className="text-sm text-zinc-400">Joining workspace…</p>
                    </div>
                )}

                {status === 'done' && (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <CheckCircle className="h-8 w-8 text-emerald-400" />
                        <div>
                            <p className="text-base font-semibold text-zinc-100">You&apos;re in!</p>
                            <p className="text-sm text-zinc-500 mt-1">Redirecting to your workspace…</p>
                        </div>
                    </div>
                )}

                {status === 'error' && (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <XCircle className="h-8 w-8 text-red-400" />
                        <div>
                            <p className="text-base font-semibold text-zinc-100">Invite invalid</p>
                            <p className="text-sm text-zinc-500 mt-1">{errorMsg}</p>
                        </div>
                        <Link href="/" className="mt-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                            Go to dashboard →
                        </Link>
                    </div>
                )}
            </div>
        </div>
    )
}
