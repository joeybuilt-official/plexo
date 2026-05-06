// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Messages pairing UI (ADR-0005).
 *
 * State machine: consent → starting → waiting → linked / expired / errored.
 * Copy is locked per ADR-0005 §"Copy lock" — do NOT improvise the consent
 * screen text; it's the legal anchor for "user understood phone-level
 * access."
 */

'use client'

export const dynamic = 'force-dynamic'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useWorkspaceId } from '@web/context/workspace'
import { API_BASE } from '@web/app/app/connections/_components/types'

type PairState = 'consent' | 'starting' | 'waiting' | 'linked' | 'expired' | 'errored'

const POLL_INTERVAL_MS = 2000
const CONSENT_COPY = 'Pairing connects your Google Messages to Plexo. Plexo and authorized apps will be able to read and send SMS, MMS, and RCS messages on your behalf.'

interface PairStartResponse {
    pairingId: string
    qrUrl: string
    expiresAt: string
}

interface PairStatusResponse {
    state: PairState
    errorDetail?: string
    expiresAt?: string
    connectionId?: string
    channelId?: string
    pairedSessionId?: string
}

export default function GmessagesPairPage() {
    return (
        <Suspense fallback={<PairFrame><Loader2 className="h-6 w-6 animate-spin text-text-muted" /></PairFrame>}>
            <GmessagesPairContent />
        </Suspense>
    )
}

function GmessagesPairContent() {
    const workspaceId = useWorkspaceId()
    const router = useRouter()
    const searchParams = useSearchParams()
    const returnTo = searchParams?.get('return') ?? null

    const [state, setState] = useState<PairState>('consent')
    const [consentChecked, setConsentChecked] = useState(false)
    const [pair, setPair] = useState<PairStartResponse | null>(null)
    const [errorDetail, setErrorDetail] = useState<string | null>(null)
    const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

    const stopPolling = useCallback(() => {
        if (pollTimer.current) {
            clearInterval(pollTimer.current)
            pollTimer.current = null
        }
    }, [])

    useEffect(() => () => stopPolling(), [stopPolling])

    const handleStart = useCallback(async () => {
        if (!workspaceId) return
        setState('starting')
        setErrorDetail(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/gmessages/pair-start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ workspaceId }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body?.error?.message ?? 'pair-start failed')
            }
            const data = await res.json() as PairStartResponse
            setPair(data)
            setState('waiting')
        } catch (err) {
            setErrorDetail(err instanceof Error ? err.message : 'unknown error')
            setState('errored')
        }
    }, [workspaceId])

    useEffect(() => {
        if (state !== 'waiting' || !pair || !workspaceId) return
        const tick = async () => {
            try {
                const url = `${API_BASE}/api/v1/connections/gmessages/pair-status?id=${encodeURIComponent(pair.pairingId)}&workspaceId=${encodeURIComponent(workspaceId)}`
                const res = await fetch(url, { credentials: 'include' })
                if (!res.ok) return // transient — keep polling
                const body = await res.json() as PairStatusResponse
                if (body.state === 'linked') {
                    stopPolling()
                    setState('linked')
                } else if (body.state === 'expired') {
                    stopPolling()
                    setState('expired')
                } else if (body.state === 'errored') {
                    stopPolling()
                    setErrorDetail(body.errorDetail ?? null)
                    setState('errored')
                }
            } catch { /* transient — keep polling */ }
        }
        void tick()
        pollTimer.current = setInterval(tick, POLL_INTERVAL_MS)
        return stopPolling
    }, [state, pair, workspaceId, stopPolling])

    const handleSuccess = useCallback(() => {
        if (returnTo === 'levio') {
            window.location.href = '/app/messages'  // Levio's surface; Phase L
            return
        }
        router.push('/app/connections')
    }, [returnTo, router])

    const handleRetry = useCallback(() => {
        setPair(null)
        setErrorDetail(null)
        setState('consent')
    }, [])

    if (state === 'consent') {
        return (
            <PairFrame title="Pair your phone">
                <div className="flex max-w-lg flex-col gap-5 text-sm text-text-primary">
                    <div className="flex gap-3 rounded-md border border-border bg-bg-subtle p-4">
                        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" />
                        <p className="leading-relaxed">{CONSENT_COPY}</p>
                    </div>
                    <label className="flex items-start gap-2">
                        <input
                            type="checkbox"
                            className="mt-1"
                            checked={consentChecked}
                            onChange={e => setConsentChecked(e.target.checked)}
                        />
                        <span>I understand and consent.</span>
                    </label>
                    <button
                        type="button"
                        disabled={!consentChecked || !workspaceId}
                        onClick={handleStart}
                        className="self-start rounded-md bg-text-primary px-4 py-2 text-sm font-medium text-bg-primary disabled:opacity-50"
                    >
                        Continue
                    </button>
                </div>
            </PairFrame>
        )
    }

    if (state === 'starting') {
        return (
            <PairFrame title="Preparing pairing">
                <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </PairFrame>
        )
    }

    if (state === 'waiting' && pair) {
        return (
            <PairFrame title="Scan the QR code on your phone">
                <div className="flex max-w-lg flex-col gap-4 text-sm text-text-primary">
                    <p className="text-text-muted">
                        On your phone, open Google Messages → menu → Device pairing → Scan QR code.
                    </p>
                    <PairQrCode url={pair.qrUrl} />
                    <p className="text-xs text-text-muted">
                        This QR code expires in 5 minutes. Waiting for your phone…
                    </p>
                </div>
            </PairFrame>
        )
    }

    if (state === 'linked') {
        return (
            <PairFrame title="Connected">
                <div className="flex max-w-md flex-col items-start gap-4 text-sm text-text-primary">
                    <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-6 w-6 text-text-primary" />
                        <span>Connected! Your Google Messages are now in Plexo.</span>
                    </div>
                    <button
                        type="button"
                        onClick={handleSuccess}
                        className="rounded-md bg-text-primary px-4 py-2 text-sm font-medium text-bg-primary"
                    >
                        Continue
                    </button>
                </div>
            </PairFrame>
        )
    }

    if (state === 'expired') {
        return (
            <PairFrame title="QR code expired">
                <div className="flex max-w-md flex-col items-start gap-4 text-sm text-text-primary">
                    <p>The pairing window timed out before your phone scanned the code.</p>
                    <button
                        type="button"
                        onClick={handleRetry}
                        className="rounded-md border border-border px-4 py-2 text-sm font-medium"
                    >
                        Try again
                    </button>
                </div>
            </PairFrame>
        )
    }

    return (
        <PairFrame title="Pairing failed">
            <div className="flex max-w-md flex-col items-start gap-4 text-sm text-text-primary">
                <div className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" />
                    <p>Pairing failed{errorDetail ? `: ${errorDetail}` : '.'} Try again.</p>
                </div>
                <button
                    type="button"
                    onClick={handleRetry}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium"
                >
                    Try again
                </button>
            </div>
        </PairFrame>
    )
}

function PairFrame({ title, children }: { title?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-1 flex-col p-6">
            {title ? <h1 className="mb-6 text-xl font-medium text-text-primary">{title}</h1> : null}
            <div className="flex flex-1 items-start">{children}</div>
        </div>
    )
}

function PairQrCode({ url }: { url: string }) {
    return (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-bg-subtle p-4">
            <div className="self-start rounded-md bg-white p-3" data-testid="gmessages-pair-qr">
                <QRCodeSVG value={url} size={224} level="M" />
            </div>
            <details className="text-xs text-text-muted">
                <summary className="cursor-pointer select-none">Can't scan? Show pairing URL</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-text-primary" data-testid="gmessages-pair-url">
                    {url}
                </pre>
            </details>
        </div>
    )
}
