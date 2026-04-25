// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * IntegrationsNudgeModal
 *
 * Appears once per session when Brave Search or Deepgram are not configured.
 * Lets the user paste keys and verify inline — no navigation required.
 * "Not now" dismisses for the session. "Don't ask again" persists to localStorage.
 */

import { useState, useEffect, useRef } from 'react'
import { useWorkspace } from '@web/context/workspace'
import { useFocusTrap } from '@web/hooks/use-focus-trap'
import {
    Search,
    Mic,
    ImageIcon,
    X,
    ExternalLink,
    Eye,
    EyeOff,
    Loader2,
    CheckCircle2,
    AlertCircle,
} from 'lucide-react'

const API_BASE = typeof window !== 'undefined'
    ? ''
    : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

const LS_DONT_ASK = 'plexo:integrations-nudge:dismissed'
const SS_SEEN = 'plexo:integrations-nudge:seen'

type SaveState = 'idle' | 'saving' | 'ok' | 'error'

interface IntegrationCardProps {
    icon: React.ReactNode
    name: string
    tagline: string
    placeholder: string
    getKeyUrl: string
    getKeyLabel: string
    onSave: (key: string) => Promise<{ ok: boolean; message: string }>
    onConfigured: () => void
}

function IntegrationCard({
    icon, name, tagline, placeholder, getKeyUrl, getKeyLabel, onSave, onConfigured,
}: IntegrationCardProps) {
    const [key, setKey] = useState('')
    const [showKey, setShowKey] = useState(false)
    const [state, setState] = useState<SaveState>('idle')
    const [message, setMessage] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => { inputRef.current?.focus() }, [])

    async function handleSave() {
        const trimmed = key.trim()
        if (!trimmed) return
        setState('saving')
        setMessage('')
        try {
            const result = await onSave(trimmed)
            setState(result.ok ? 'ok' : 'error')
            setMessage(result.message)
            if (result.ok) setTimeout(onConfigured, 600)
        } catch (err) {
            setState('error')
            setMessage(err instanceof Error ? err.message : 'Unexpected error')
        }
    }

    return (
        <div className="rounded border border-border bg-surface-2/40 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded bg-azure-dim border border-azure/20 shrink-0">
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary">{name}</p>
                    <p className="text-xs text-text-muted leading-snug mt-0.5">{tagline}</p>
                </div>
                <a
                    href={getKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 flex items-center gap-1 text-xs text-azure hover:underline whitespace-nowrap"
                >
                    {getKeyLabel} <ExternalLink className="h-3 w-3" />
                </a>
            </div>

            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <input
                        ref={inputRef}
                        type={showKey ? 'text' : 'password'}
                        value={key}
                        onChange={e => setKey(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && void handleSave()}
                        placeholder={placeholder}
                        disabled={state === 'saving' || state === 'ok'}
                        className="w-full rounded border border-border bg-canvas px-3 py-2 pr-10 text-[15px] sm:text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-azure focus:border-azure transition-colors font-mono min-h-[40px] disabled:opacity-50"
                        autoComplete="new-password"
                    />
                    <button
                        type="button"
                        onClick={() => setShowKey(v => !v)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-text-muted hover:text-text-secondary"
                        tabIndex={-1}
                    >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                </div>
                <button
                    onClick={() => void handleSave()}
                    disabled={!key.trim() || state === 'saving' || state === 'ok'}
                    className="flex items-center gap-1.5 rounded bg-azure hover:bg-azure/90 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 text-sm font-medium text-text-primary transition-colors whitespace-nowrap min-h-[40px]"
                >
                    {state === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                     state === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                    {state === 'saving' ? 'Saving…' : state === 'ok' ? 'Saved' : 'Save & verify'}
                </button>
            </div>

            {message && (
                <div className={`flex items-start gap-2 rounded px-3 py-2 text-xs ${
                    state === 'ok'
                        ? 'bg-azure/5 border border-azure/20 text-azure-300'
                        : 'bg-red-dim border border-red-900/40 text-red-300'
                }`}>
                    {state === 'ok'
                        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        : <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                    {message}
                </div>
            )}
        </div>
    )
}

export function IntegrationsNudgeModal() {
    const { workspaceId } = useWorkspace()
    const [open, setOpen] = useState(false)
    const [missing, setMissing] = useState<{ search: boolean; voice: boolean; vision: boolean }>({ search: false, voice: false, vision: false })
    const [configured, setConfigured] = useState<{ search: boolean; voice: boolean; vision: boolean }>({ search: false, voice: false, vision: false })

    useEffect(() => {
        if (!workspaceId) return
        if (typeof window === 'undefined') return

        // Respect permanent dismissal
        if (localStorage.getItem(LS_DONT_ASK) === workspaceId) return
        // Only show once per session
        if (sessionStorage.getItem(SS_SEEN) === workspaceId) return

        // Fetch all three in parallel
        Promise.all([
            fetch(`${API_BASE}/api/v1/search/settings?workspaceId=${workspaceId}`)
                .then(r => r.ok ? r.json() as Promise<{ configured: boolean }> : null)
                .catch(() => null),
            fetch(`${API_BASE}/api/v1/voice/settings?workspaceId=${workspaceId}`)
                .then(r => r.ok ? r.json() as Promise<{ configured: boolean }> : null)
                .catch(() => null),
            fetch(`${API_BASE}/api/v1/vision/status?workspaceId=${workspaceId}`)
                .then(r => r.ok ? r.json() as Promise<{ configured: boolean }> : null)
                .catch(() => null),
        ]).then(([search, voice, vision]) => {
            const needsSearch = !search?.configured
            const needsVoice = !voice?.configured
            const needsVision = !vision?.configured
            if (needsSearch || needsVoice || needsVision) {
                setMissing({ search: needsSearch, voice: needsVoice, vision: needsVision })
                setOpen(true)
            }
            // Mark as seen for this session regardless
            sessionStorage.setItem(SS_SEEN, workspaceId)
        })
    }, [workspaceId])

    function dismiss(permanent: boolean) {
        if (permanent && workspaceId) localStorage.setItem(LS_DONT_ASK, workspaceId)
        setOpen(false)
    }

    function handleConfigured(type: 'search' | 'voice' | 'vision') {
        setConfigured(prev => {
            const next = { ...prev, [type]: true }
            // If all missing ones are now configured, close after a beat
            const allDone =
                (!missing.search || next.search) &&
                (!missing.voice || next.voice) &&
                (!missing.vision || next.vision)
            if (allDone) setTimeout(() => setOpen(false), 800)
            return next
        })
    }

    async function saveSearch(key: string): Promise<{ ok: boolean; message: string }> {
        if (!workspaceId) return { ok: false, message: 'No workspace' }
        const saveRes = await fetch(`${API_BASE}/api/v1/search/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, apiKey: key }),
        })
        if (!saveRes.ok) return { ok: false, message: 'Save failed' }
        const testRes = await fetch(`${API_BASE}/api/v1/search/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, apiKey: key }),
        })
        return testRes.json() as Promise<{ ok: boolean; message: string }>
    }

    async function saveVoice(key: string): Promise<{ ok: boolean; message: string }> {
        if (!workspaceId) return { ok: false, message: 'No workspace' }
        const saveRes = await fetch(`${API_BASE}/api/v1/voice/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, apiKey: key }),
        })
        if (!saveRes.ok) return { ok: false, message: 'Save failed' }
        const testRes = await fetch(`${API_BASE}/api/v1/voice/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, apiKey: key }),
        })
        return testRes.json() as Promise<{ ok: boolean; message: string }>
    }

    // Esc to close
    useEffect(() => {
        if (!open) return
        function handler(e: KeyboardEvent) {
            if (e.key === 'Escape') { dismiss(false) }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

    const trapRef = useFocusTrap<HTMLDivElement>(true)

    if (!open) return null

    const unconfiguredCount = (missing.search && !configured.search ? 1 : 0) + (missing.voice && !configured.voice ? 1 : 0) + (missing.vision && !configured.vision ? 1 : 0)

    return (
        <div ref={trapRef} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 " role="dialog" aria-modal="true" aria-labelledby="integrations-modal-title">
            <div className="w-full max-w-lg rounded border border-border bg-surface-1  overflow-hidden">

                {/* Header */}
                <div className="flex items-start justify-between px-5 pt-5 pb-4">
                    <div>
                        <h2 id="integrations-modal-title" className="text-base font-semibold text-text-primary">
                            {unconfiguredCount === 1 ? 'One recommended integration' : `${unconfiguredCount} recommended integrations`} to set up
                        </h2>
                        <p className="mt-1 text-xs text-text-muted leading-relaxed">
                            These unlock capabilities your agent will use. Both are free to start.
                            You can also configure them later in Settings.
                        </p>
                    </div>
                    <button
                        onClick={() => dismiss(false)}
                        className="ml-4 shrink-0 rounded p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                        aria-label="Dismiss"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Integration cards */}
                <div className="px-5 flex flex-col gap-3">
                    {missing.search && !configured.search && (
                        <IntegrationCard
                            icon={<Search className="h-4 w-4 text-azure" />}
                            name="Brave Search"
                            tagline="Full web index — current TV shows, news, products. 2,000 queries/month free."
                            placeholder="BSA…"
                            getKeyUrl="https://api-dashboard.search.brave.com/app/keys"
                            getKeyLabel="Get a free key"
                            onSave={saveSearch}
                            onConfigured={() => handleConfigured('search')}
                        />
                    )}
                    {missing.voice && !configured.voice && (
                        <IntegrationCard
                            icon={<Mic className="h-4 w-4 text-azure" />}
                            name="Deepgram"
                            tagline="Voice transcription for web chat and messaging channels. $200 in free credits."
                            placeholder="Paste your Deepgram API key…"
                            getKeyUrl="https://console.deepgram.com/signup"
                            getKeyLabel="Get free credits"
                            onSave={saveVoice}
                            onConfigured={() => handleConfigured('voice')}
                        />
                    )}
                    {missing.vision && !configured.vision && (
                        <div className="rounded border border-border bg-surface-2/40 p-4 flex flex-col gap-3">
                            <div className="flex items-center gap-3">
                                <div className="flex h-9 w-9 items-center justify-center rounded bg-azure-dim border border-azure/20 shrink-0">
                                    <ImageIcon className="h-4 w-4 text-azure" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-text-primary">Image / Vision</p>
                                    <p className="text-xs text-text-muted leading-snug mt-0.5">
                                        Let your agent see and analyze photos, screenshots, and images. Claude, GPT-4o, and Gemini all support vision.
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <a
                                    href="/app/settings/intelligence"
                                    className="flex-1 flex items-center justify-center gap-2 rounded bg-azure hover:bg-azure/90 px-3 py-2 text-sm font-medium text-text-primary transition-colors min-h-[40px]"
                                    onClick={() => { dismiss(false); handleConfigured('vision') }}
                                >
                                    Set up a vision provider
                                </a>
                                <a
                                    href="/app/settings/intelligence"
                                    className="shrink-0 flex items-center gap-1 text-xs text-azure hover:underline whitespace-nowrap"
                                >
                                    Vision-capable providers <ExternalLink className="h-3 w-3" />
                                </a>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 mt-3">
                    <button
                        onClick={() => dismiss(true)}
                        className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                        Don&apos;t ask again
                    </button>
                    <button
                        onClick={() => dismiss(false)}
                        className="rounded border border-border bg-surface-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:border-border transition-colors"
                    >
                        Not now
                    </button>
                </div>
            </div>
        </div>
    )
}
