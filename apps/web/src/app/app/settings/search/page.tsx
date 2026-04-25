// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef } from 'react'
import { useUnsavedChanges } from '@web/hooks/use-unsaved-changes'
import { useWorkspace } from '@web/context/workspace'
import { useConfirm } from '@web/components/ui/confirm-dialog'
import {
    Search,
    CheckCircle2,
    AlertCircle,
    Circle,
    ExternalLink,
    Eye,
    EyeOff,
    X,
    Loader2,
    Zap,
} from 'lucide-react'

const API_BASE = typeof window !== 'undefined'
    ? ''
    : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
const CONFIGURED_SENTINEL = '__configured__'

type TestStatus = 'idle' | 'testing' | 'ok' | 'error'
type KeySource = 'workspace' | 'environment' | 'none'

interface SearchSettings {
    configured: boolean
    source: KeySource
    apiKey: string | null
}

function StatusDot({ status }: { status: TestStatus }) {
    if (status === 'testing') return <Loader2 className="h-4 w-4 animate-spin text-azure" />
    if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-azure" />
    if (status === 'error') return <AlertCircle className="h-4 w-4 text-red" />
    return <Circle className="h-4 w-4 text-text-muted" />
}

export default function SearchSettingsPage() {
    const { workspaceId } = useWorkspace()
    const confirmAction = useConfirm()
    const [settings, setSettings] = useState<SearchSettings | null>(null)
    const [loading, setLoading] = useState(true)

    const [editing, setEditing] = useState(false)
    const [keyInput, setKeyInput] = useState('')
    const [showKey, setShowKey] = useState(false)

    const [saving, setSaving] = useState(false)
    const [testStatus, setTestStatus] = useState<TestStatus>('idle')
    const [testMessage, setTestMessage] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    useUnsavedChanges(editing && keyInput.trim().length > 0)

    // ── Load settings ─────────────────────────────────────────────────────────

    useEffect(() => {
        if (!workspaceId) return
        setLoading(true)
        fetch(`${API_BASE}/api/v1/search/settings?workspaceId=${workspaceId}`)
            .then(r => r.ok ? r.json() as Promise<SearchSettings> : null)
            .then(data => {
                if (data) {
                    setSettings(data)
                    if (data.configured) setTestStatus('ok')
                }
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
            if (key && key !== CONFIGURED_SENTINEL) {
                const saveRes = await fetch(`${API_BASE}/api/v1/search/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId, apiKey: key }),
                })
                if (!saveRes.ok) throw new Error('Save failed')
                setSettings(s => s ? { ...s, configured: true, source: 'workspace' } : s)
            }

            const testRes = await fetch(`${API_BASE}/api/v1/search/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, apiKey: key || undefined }),
            })
            const testData = await testRes.json() as { ok: boolean; message: string }

            setTestStatus(testData.ok ? 'ok' : 'error')
            setTestMessage(testData.message)

            if (testData.ok) {
                setEditing(false)
                setKeyInput('')
                setShowKey(false)
                setSettings(s => s ? { ...s, configured: true, source: 'workspace' } : s)
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
        if (!await confirmAction({ title: 'Remove API key', description: 'Remove the Brave Search API key? Web search will fall back to DuckDuckGo (limited coverage).', confirmLabel: 'Remove', variant: 'warning' })) return
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/v1/search/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, apiKey: '__CLEAR__' }),
            })
            setSettings(s => s ? { ...s, configured: false, source: 'none', apiKey: null } : s)
            setEditing(false)
            setKeyInput('')
            setTestStatus('idle')
            setTestMessage('')
        } finally {
            setSaving(false)
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    const isEnvConfigured = settings?.source === 'environment'

    return (
        <div className="flex flex-col gap-8 max-w-2xl">

            {/* Page header */}
            <div>
                <h1 className="text-2xl font-medium text-text-primary tracking-tight">Web Search</h1>
                <p className="mt-1 text-sm text-text-muted">
                    Powers real-time web lookups in chat conversations and agent tasks.
                    Without a Brave Search key, the agent falls back to DuckDuckGo Instant Answer —
                    which only covers Wikipedia-indexed topics and misses recent releases, niche entities, and live events.
                </p>
            </div>

            {/* Brave Search card */}
            <div className="rounded-sm border border-border bg-surface-1/60 overflow-hidden">

                {/* Card header */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 px-4 sm:px-6 py-4 sm:py-5 border-b border-border">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-azure-dim border border-azure/20">
                            <Search className="h-5 w-5 text-azure" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-base font-medium text-text-primary">Brave Search</span>
                                <span className="rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide bg-azure/15 text-azure border border-azure/30">
                                    RECOMMENDED
                                </span>
                            </div>
                            <p className="text-xs text-text-muted mt-0.5">
                                Full web index · Handles recent + niche entities · 2,000 queries/month free
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-1">
                        <StatusDot status={loading ? 'idle' : testStatus} />
                        <span className="text-xs text-text-muted">
                            {loading ? 'Loading…' : settings?.configured
                                ? isEnvConfigured ? 'Configured (environment)' : 'Configured'
                                : 'Not configured'}
                        </span>
                    </div>
                </div>

                {/* Card body */}
                <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-5">

                    {/* Free tier callout */}
                    <div className="flex items-start gap-3 rounded-sm border border-azure/20 bg-azure/5 p-4">
                        <Zap className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                        <div>
                            <p className="text-sm font-medium text-azure-300">2,000 free queries/month — no credit card required</p>
                            <p className="mt-1 text-xs text-text-muted leading-relaxed">
                                Brave Search indexes the full web independently of Google. Your agent uses it to look up
                                current TV shows, recent product releases, live news, and anything that postdates training
                                data. Free tier covers typical personal and small-team use.
                            </p>
                            <a
                                href="https://api-dashboard.search.brave.com/app/keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex items-center gap-1.5 text-xs text-azure hover:text-azure transition-colors"
                            >
                                Create free Brave Search account
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </div>

                    {/* Environment key notice */}
                    {isEnvConfigured && (
                        <div className="flex items-start gap-2.5 rounded-sm border border-border/50 bg-surface-2/30 px-3 py-2.5">
                            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                            <p className="text-xs text-text-secondary leading-relaxed">
                                A <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">BRAVE_SEARCH_API_KEY</code> environment
                                variable is set on this server. All workspaces share it as a fallback. Add a workspace key below to
                                override it with your own quota.
                            </p>
                        </div>
                    )}

                    {/* API Key section */}
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-text-secondary">API Key</label>
                            <a
                                href="https://api-dashboard.search.brave.com/app/keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-azure hover:text-azure transition-colors"
                            >
                                Get API key
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>

                        {settings?.configured && settings.source === 'workspace' && !editing ? (
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-2">
                                <div className="flex-1 flex items-center gap-3 rounded-sm border border-border/50 bg-surface-2/30 px-3 py-2.5 min-h-[44px]">
                                    <CheckCircle2 className="h-4 w-4 text-azure shrink-0" />
                                    <span className="text-xs text-azure font-medium whitespace-nowrap">Key saved and verified</span>
                                    <span className="ml-auto font-mono text-xs text-text-muted truncate">••••••••••••••••••••••••</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={startEditing}
                                        className="flex-1 sm:flex-initial rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-xs text-text-secondary hover:text-text-primary hover:border-border transition-colors min-h-[44px]"
                                    >
                                        Change
                                    </button>
                                    <button
                                        onClick={clearKey}
                                        disabled={saving}
                                        title="Remove key"
                                        className="rounded-sm border border-border bg-surface-2 p-2.5 text-text-muted hover:text-red hover:border-red-500/40 transition-colors shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            ref={inputRef}
                                            type={showKey ? 'text' : 'password'}
                                            value={keyInput}
                                            onChange={e => setKeyInput(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && void saveAndTest()}
                                            placeholder="Paste your Brave Search API key…"
                                            className="w-full rounded-sm border border-border bg-surface-2/60 px-3 py-2.5 pr-11 text-[16px] sm:text-sm text-text-primary placeholder-text-muted focus-ring focus:ring-1 focus:ring-azure focus:border-azure transition-colors font-mono min-h-[44px]"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowKey(v => !v)}
                                            aria-label={showKey ? 'Hide API key' : 'Show API key'}
                                            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary min-h-[44px] min-w-[44px] flex items-center justify-center"
                                        >
                                            {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => void saveAndTest()}
                                            disabled={saving || (!keyInput.trim() && !settings?.configured)}
                                            className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-sm bg-azure hover:bg-azure/90 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-medium text-text-primary transition-colors whitespace-nowrap min-h-[44px]"
                                        >
                                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                            Save &amp; Test
                                        </button>
                                        {editing && (
                                            <button
                                                onClick={cancelEditing}
                                                aria-label="Cancel editing"
                                                className="rounded-sm border border-border bg-surface-2 p-2.5 text-text-muted hover:text-text-secondary transition-colors shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <p className="text-xs text-text-muted">
                                    Encrypted at rest (AES-256-GCM). Leave blank to use the server environment key.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Test result */}
                    {testMessage && (
                        <div className={`flex items-start gap-2.5 rounded-sm px-3 py-2.5 text-xs ${
                            testStatus === 'ok'
                                ? 'bg-azure-dim border border-azure/20 text-azure-300'
                                : 'bg-red-dim border border-red-500/20 text-red-300'
                        }`}>
                            {testStatus === 'ok'
                                ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                                : <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
                            <span>{testMessage}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* How search works */}
            <div className="rounded-sm border border-border bg-surface-1/60 px-4 sm:px-6 py-4 sm:py-5">
                <h2 className="text-sm font-medium text-text-primary mb-4">How web search works</h2>
                <div className="flex flex-col gap-4">
                    {[
                        {
                            title: 'Conversations',
                            desc: 'When you ask Plexo about a real-world entity in chat — a TV show, person, product, company, recent event — it calls web_search before responding. Results are injected into the context so the answer is grounded in current data, not training memory.',
                        },
                        {
                            title: 'Agent tasks',
                            desc: 'Tasks that require live research (market analysis, content research, fact-checking) use the same search pipeline. The agent calls web_search autonomously as needed during task execution.',
                        },
                        {
                            title: 'Fallback behavior',
                            desc: "Without a Brave Search key, Plexo falls back to DuckDuckGo Instant Answer — a read-only API that only returns results for topics with a Wikipedia summary page. Anything recent, niche, or not yet Wikipedia-indexed returns empty. The agent will report \"no results\" rather than invent an answer.",
                        },
                    ].map(item => (
                        <div key={item.title} className="flex items-start gap-3">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-surface-2 border border-border/50">
                                <Search className="h-3.5 w-3.5 text-azure" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-text-primary">{item.title}</p>
                                <p className="text-xs text-text-muted leading-relaxed mt-0.5">{item.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

        </div>
    )
}
