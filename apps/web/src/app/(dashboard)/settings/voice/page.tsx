// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef } from 'react'
import { useWorkspace } from '@web/context/workspace'
import {
    Mic,
    CheckCircle2,
    AlertCircle,
    Circle,
    ExternalLink,
    Eye,
    EyeOff,
    X,
    Loader2,
    Radio,
    Volume2,
} from 'lucide-react'

const API_BASE = typeof window !== 'undefined'
    ? ''  // browser: relative URL, Caddy proxies /api → API container
    : (process.env.INTERNAL_API_URL || 'http://localhost:3001') // SSR: direct internal
const CONFIGURED_SENTINEL = '__configured__'

type TestStatus = 'idle' | 'testing' | 'ok' | 'error'

interface VoiceSettings {
    configured: boolean
    apiKey: string | null
    enabled: boolean
}

// ── Status indicator ──────────────────────────────────────────────────────────

function StatusDot({ status }: { status: TestStatus }) {
    if (status === 'testing') return <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
    if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    if (status === 'error') return <AlertCircle className="h-4 w-4 text-red-400" />
    return <Circle className="h-4 w-4 text-zinc-600" />
}

export default function VoiceSettingsPage() {
    const { workspaceId } = useWorkspace()
    const [settings, setSettings] = useState<VoiceSettings | null>(null)
    const [loading, setLoading] = useState(true)

    // Key input state
    const [editing, setEditing] = useState(false)
    const [keyInput, setKeyInput] = useState('')
    const [showKey, setShowKey] = useState(false)

    // Save/test
    const [saving, setSaving] = useState(false)
    const [testStatus, setTestStatus] = useState<TestStatus>('idle')
    const [testMessage, setTestMessage] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    // ── Load settings ─────────────────────────────────────────────────────────

    useEffect(() => {
        if (!workspaceId) return
        setLoading(true)
        fetch(`${API_BASE}/api/v1/voice/settings?workspaceId=${workspaceId}`)
            .then(r => r.ok ? r.json() as Promise<VoiceSettings> : null)
            .then(data => {
                if (data) setSettings(data)
            })
            .catch(() => null)
            .finally(() => setLoading(false))
    }, [workspaceId])

    // ── Actions ───────────────────────────────────────────────────────────────

    function startEditing() {
        setEditing(true)
        setKeyInput('')
        setTestStatus('idle')
        setTestMessage('')
        setTimeout(() => inputRef.current?.focus(), 50)
    }

    function cancelEditing() {
        setEditing(false)
        setKeyInput('')
        setShowKey(false)
        setTestStatus('idle')
        setTestMessage('')
    }

    async function saveAndTest() {
        if (!workspaceId) return
        const key = keyInput.trim()
        if (!key && !settings?.configured) return

        setSaving(true)
        setTestStatus('testing')
        setTestMessage('')

        try {
            // Save first (if a new key was entered)
            if (key && key !== CONFIGURED_SENTINEL) {
                const saveRes = await fetch(`${API_BASE}/api/v1/voice/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId, apiKey: key }),
                })
                if (!saveRes.ok) throw new Error('Save failed')
                setSettings(s => s ? { ...s, configured: true } : s)
            }

            // Test
            const testRes = await fetch(`${API_BASE}/api/v1/voice/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    // Pass the plaintext key if we just entered one; otherwise let the backend use stored
                    apiKey: key || undefined,
                }),
            })
            const testData = await testRes.json() as { ok: boolean; message: string }

            setTestStatus(testData.ok ? 'ok' : 'error')
            setTestMessage(testData.message)

            if (testData.ok) {
                setEditing(false)
                setKeyInput('')
                setShowKey(false)
                setSettings(s => s ? { ...s, configured: true } : s)
            }
        } catch (err) {
            setTestStatus('error')
            setTestMessage(err instanceof Error ? err.message : 'Unexpected error')
        } finally {
            setSaving(false)
        }
    }

    async function clearKey() {
        if (!workspaceId) return
        if (!confirm('Remove the Deepgram API key? Voice transcription will stop working.')) return
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/v1/voice/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, apiKey: '__CLEAR__' }),
            })
            setSettings(s => s ? { ...s, configured: false, apiKey: null } : s)
            setEditing(false)
            setKeyInput('')
            setTestStatus('idle')
            setTestMessage('')
        } finally {
            setSaving(false)
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col gap-8 max-w-2xl">

            {/* Page header */}
            <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">Voice</h1>
                <p className="mt-1 text-sm text-zinc-500">
                    Speech-to-text pipeline for any audio source — web chat, messaging channels,
                    integrations, and future apps. One key, one budget, independent of your LLM providers.
                </p>
            </div>

            {/* Deepgram card */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">

                {/* Card header */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 px-4 sm:px-6 py-4 sm:py-5 border-b border-zinc-800">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                            <Mic className="h-5 w-5 text-indigo-400" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-base font-semibold text-white">Deepgram</span>
                                <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                    RECOMMENDED
                                </span>
                            </div>
                            <p className="text-xs text-zinc-500 mt-0.5">
                                Nova-3 model · Industry-leading accuracy · $200 free credits
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-1">
                        <StatusDot status={loading ? 'idle' : testStatus} />
                        <span className="text-xs text-zinc-500">
                            {loading ? 'Loading…' : settings?.configured ? 'Configured' : 'Not configured'}
                        </span>
                    </div>
                </div>

                {/* Card body */}
                <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-5">

                    {/* Free credits callout */}
                    <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                        <Volume2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
                        <div>
                            <p className="text-sm font-medium text-emerald-300">$200 in free credits — no credit card required to start</p>
                            <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
                                Deepgram&apos;s Nova-3 model delivers best-in-class transcription accuracy. Free credits cover
                                approximately 20,000 minutes of audio. Create a free account, generate an API key, and paste
                                it below.
                            </p>
                            <a
                                href="https://console.deepgram.com/signup"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                                Create free Deepgram account
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </div>

                    {/* API Key section */}
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-zinc-300">API Key</label>
                            <a
                                href="https://console.deepgram.com/project/keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                                Get API key
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>

                        {settings?.configured && !editing ? (
                            // Configured state — show locked field + Change button
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-2">
                                <div className="flex-1 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-800/30 px-3 py-2.5 min-h-[44px]">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                                    <span className="text-xs text-emerald-400 font-medium whitespace-nowrap">Key saved and verified</span>
                                    <span className="ml-auto font-mono text-xs text-zinc-600 truncate max-w-[50px] sm:max-w-none">••••••••••••••••••••••••</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={startEditing}
                                        className="flex-1 sm:flex-initial rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-xs text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors min-h-[44px]"
                                    >
                                        Change
                                    </button>
                                    <button
                                        onClick={clearKey}
                                        disabled={saving}
                                        title="Remove key"
                                        className="rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-zinc-600 hover:text-red-400 hover:border-red-500/40 transition-colors shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            // Input state
                            <div className="flex flex-col gap-2">
                                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            ref={inputRef}
                                            type={showKey ? 'text' : 'password'}
                                            value={keyInput}
                                            onChange={e => setKeyInput(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && void saveAndTest()}
                                            placeholder="Paste your Deepgram API key…"
                                            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 pr-11 text-[16px] sm:text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors font-mono min-h-[44px]"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowKey(v => !v)}
                                            className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 min-h-[44px] min-w-[44px] flex items-center justify-center p-0 m-0"
                                        >
                                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </button>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => void saveAndTest()}
                                            disabled={saving || (!keyInput.trim() && !settings?.configured)}
                                            className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-medium text-white transition-colors whitespace-nowrap min-h-[44px]"
                                        >
                                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                            Save &amp; Test
                                        </button>

                                        {editing && (
                                            <button
                                                onClick={cancelEditing}
                                                className="rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <p className="text-xs text-zinc-600">
                                    Encrypted at rest (AES-256-GCM). Leave blank to keep the existing key.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Test result */}
                    {testMessage && (
                        <div className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs ${
                            testStatus === 'ok'
                                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                                : 'bg-red-500/10 border border-red-500/20 text-red-300'
                        }`}>
                            {testStatus === 'ok'
                                ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                                : <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
                            <span>{testMessage}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* How voice works */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 sm:px-6 py-4 sm:py-5 mt-4">
                <h2 className="text-sm font-semibold text-white mb-4">How voice processing works</h2>
                <div className="flex flex-col gap-4">
                    {[
                        {
                            icon: <Mic className="h-4 w-4 text-indigo-400" />,
                            title: 'Web chat',
                            desc: 'Click the microphone button in Chat. Audio is recorded in your browser and sent to Deepgram for transcription. The transcript is inserted into the message field — you can review before sending.',
                        },
                        {
                            icon: <Radio className="h-4 w-4 text-indigo-400" />,
                            title: 'Channels & integrations',
                            desc: 'Voice messages sent via Telegram, Slack, Discord, or any future channel are automatically downloaded, transcribed, and routed through the same intent classification pipeline as text. No per-channel configuration needed — one Deepgram key covers everything.',
                        },
                        {
                            icon: <Volume2 className="h-4 w-4 text-indigo-400" />,
                            title: 'Token isolation',
                            desc: 'Voice transcription uses a completely separate Deepgram API key and budget. It never touches your LLM provider credits — a Deepgram outage cannot affect task execution.',
                        },
                    ].map(item => (
                        <div key={item.title} className="flex items-start gap-3">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800 border border-zinc-700/50">
                                {item.icon}
                            </div>
                            <div>
                                <p className="text-sm font-medium text-zinc-200">{item.title}</p>
                                <p className="text-xs text-zinc-500 leading-relaxed mt-0.5">{item.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

        </div>
    )
}
