// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * In-dashboard setup wizard overlay.
 *
 * Shown when a workspace exists but has NO AI provider configured.
 * The standalone /setup page handles the "no workspace at all" case;
 * this handles the "workspace exists, needs a provider" case that
 * happens after login or after a workspace is created via API.
 *
 * 3 steps:
 *   1. Connect a model — provider grid + API key input with live validation
 *   2. Name your workspace — single input, pre-filled
 *   3. Your first task — pre-filled example with "Run this" button
 */

import { useState, useEffect, useCallback } from 'react'
import {
    Check,
    ChevronRight,
    ExternalLink,
    Loader2,
    AlertCircle,
    Sparkles,
    X,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

// ── Provider catalog ─────────────────────────────────────────────────────────

const PROVIDERS = [
    { key: 'anthropic',   name: 'Anthropic',    placeholder: 'sk-ant-api03-…',            link: 'https://console.anthropic.com/keys' },
    { key: 'openai',      name: 'OpenAI',       placeholder: 'sk-proj-…',                 link: 'https://platform.openai.com/api-keys' },
    { key: 'deepseek',    name: 'DeepSeek',     placeholder: 'sk-…',                      link: 'https://platform.deepseek.com/api_keys' },
    { key: 'groq',        name: 'Groq',         placeholder: 'gsk_…',                     link: 'https://console.groq.com/keys' },
    { key: 'ollama',      name: 'Ollama',       placeholder: 'http://localhost:11434',     link: 'https://ollama.com' },
    { key: 'openrouter',  name: 'OpenRouter',   placeholder: 'sk-or-v1-…',                link: 'https://openrouter.ai/keys' },
] as const

type ProviderKey = typeof PROVIDERS[number]['key']

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

// ── Hook: check if any AI provider is configured ─────────────────────────────

function useHasProvider(workspaceId: string): { loading: boolean; hasProvider: boolean | null } {
    const [loading, setLoading] = useState(true)
    const [hasProvider, setHasProvider] = useState<boolean | null>(null)

    useEffect(() => {
        if (!workspaceId) { setLoading(false); return }
        let cancelled = false

        fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((data: { providers?: Record<string, { apiKey?: string; baseUrl?: string; status?: string }> } | null) => {
                if (cancelled) return
                if (!data?.providers) { setHasProvider(false); setLoading(false); return }
                // Check if at least one provider has a key or base URL set
                const configured = Object.values(data.providers).some(
                    (p) => (p.apiKey && p.apiKey.length > 0) || (p.baseUrl && p.baseUrl.length > 0)
                )
                setHasProvider(configured)
                setLoading(false)
            })
            .catch(() => { if (!cancelled) { setHasProvider(null); setLoading(false) } })

        return () => { cancelled = true }
    }, [workspaceId])

    return { loading, hasProvider }
}

// ── Wizard component ─────────────────────────────────────────────────────────

interface SetupWizardProps {
    children: React.ReactNode
}

export function SetupWizardGate({ children }: SetupWizardProps) {
    const { workspaceId, workspaceName } = useWorkspace()
    const { loading, hasProvider } = useHasProvider(workspaceId)
    const [dismissed, setDismissed] = useState(false)

    // Check localStorage for dismissal
    useEffect(() => {
        const key = `plexo_wizard_dismissed_${workspaceId}`
        if (typeof window !== 'undefined' && localStorage.getItem(key) === 'true') {
            setDismissed(true)
        }
    }, [workspaceId])

    if (loading || hasProvider !== false || dismissed) return <>{children}</>

    return (
        <>
            <SetupWizardOverlay
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                onComplete={() => setDismissed(true)}
                onDismiss={() => {
                    setDismissed(true)
                    try {
                        localStorage.setItem(`plexo_wizard_dismissed_${workspaceId}`, 'true')
                    } catch { /* non-fatal */ }
                }}
            />
            {children}
        </>
    )
}

// ── Overlay ──────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3

interface OverlayProps {
    workspaceId: string
    workspaceName: string
    onComplete: () => void
    onDismiss: () => void
}

function SetupWizardOverlay({ workspaceId, workspaceName, onComplete, onDismiss }: OverlayProps) {
    const [step, setStep] = useState<Step>(1)
    const [selected, setSelected] = useState<ProviderKey>('anthropic')
    const [credential, setCredential] = useState('')
    const [saving, setSaving] = useState(false)
    const [validating, setValidating] = useState(false)
    const [validated, setValidated] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [wsName, setWsName] = useState(workspaceName || 'My Workspace')
    const [taskSubmitting, setTaskSubmitting] = useState(false)
    const [taskDone, setTaskDone] = useState(false)

    const providerMeta = PROVIDERS.find((p) => p.key === selected)!
    const isOllama = selected === 'ollama'

    // ── Live validation ──────────────────────────────────────────────────────

    const validateKey = useCallback(async () => {
        if (!credential.trim()) return
        setValidating(true)
        setError(null)
        setValidated(false)
        try {
            const res = await fetch(`${API_BASE}/api/v1/settings/ai-providers/probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: selected,
                    ...(isOllama
                        ? { baseUrl: credential.trim() || 'http://localhost:11434' }
                        : { apiKey: credential.trim() }),
                    workspaceId,
                }),
            })
            if (res.ok) {
                setValidated(true)
            } else {
                const data = await res.json().catch(() => ({})) as { error?: string; message?: string }
                setError(data.error || data.message || 'Validation failed — check your key and try again.')
            }
        } catch {
            setError('Could not reach the API server.')
        } finally {
            setValidating(false)
        }
    }, [credential, selected, isOllama, workspaceId])

    // Debounced validation on credential change
    useEffect(() => {
        setValidated(false)
        setError(null)
        if (!credential.trim()) return
        const t = setTimeout(() => { void validateKey() }, 800)
        return () => clearTimeout(t)
    }, [credential, validateKey])

    // ── Save provider ────────────────────────────────────────────────────────

    async function saveProvider() {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    primary: selected,
                    primaryProvider: selected,
                    providers: {
                        [selected]: {
                            status: validated ? 'configured' : 'untested',
                            enabled: true,
                            ...(isOllama
                                ? { baseUrl: credential.trim() || 'http://localhost:11434' }
                                : { apiKey: credential.trim() }),
                        },
                    },
                }),
            })
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string }
                setError(data.error || 'Failed to save provider.')
                return
            }
            setStep(2)
        } catch {
            setError('Network error — could not save provider.')
        } finally {
            setSaving(false)
        }
    }

    // ── Update workspace name ────────────────────────────────────────────────

    async function updateWorkspaceName() {
        if (!wsName.trim()) { setStep(3); return }
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: wsName.trim() }),
            })
        } catch { /* non-fatal — name update is best effort */ }
        setSaving(false)
        setStep(3)
    }

    // ── Submit first task ────────────────────────────────────────────────────

    const EXAMPLE_TASK = 'Research the top 5 trending open-source projects this week and summarize what makes each one interesting'

    async function submitFirstTask() {
        setTaskSubmitting(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    type: 'research',
                    source: 'dashboard',
                    context: { description: EXAMPLE_TASK },
                    priority: 10,
                }),
            })
            if (res.ok) {
                setTaskDone(true)
                setTimeout(onComplete, 1200)
            }
        } catch { /* best effort */ }
        setTaskSubmitting(false)
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-border bg-surface-1 shadow-2xl overflow-hidden">
                {/* Dismiss button */}
                <button
                    onClick={onDismiss}
                    className="absolute top-4 right-4 p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors z-10"
                    title="Skip for now"
                >
                    <X className="h-4 w-4" />
                </button>

                {/* Step indicator */}
                <div className="flex items-center gap-2 px-7 pt-6 pb-2">
                    {[1, 2, 3].map((s) => (
                        <div key={s} className="flex items-center gap-2">
                            <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition-all ${
                                s < step ? 'bg-azure text-white' :
                                s === step ? 'border-2 border-azure text-azure' :
                                'border border-border text-text-muted'
                            }`}>
                                {s < step ? <Check className="h-3 w-3" /> : s}
                            </div>
                            <span className={`text-xs ${s === step ? 'text-text-primary font-medium' : 'text-text-muted'}`}>
                                {s === 1 ? 'Connect' : s === 2 ? 'Name' : 'First task'}
                            </span>
                            {s < 3 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
                        </div>
                    ))}
                </div>

                <div className="px-7 pb-7 pt-4">
                    {/* ── Step 1: Connect a model ── */}
                    {step === 1 && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-text-primary">Connect a model</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    Plexo needs an AI provider to run tasks. Pick one to get started.
                                </p>
                            </div>

                            {/* Provider grid */}
                            <div className="grid grid-cols-3 gap-2">
                                {PROVIDERS.map((p) => (
                                    <button
                                        key={p.key}
                                        onClick={() => { setSelected(p.key); setCredential(''); setValidated(false); setError(null) }}
                                        className={`rounded-xl border px-3 py-2.5 text-xs font-medium text-center transition-all ${
                                            selected === p.key
                                                ? 'border-azure bg-azure/10 text-azure'
                                                : 'border-border text-text-secondary hover:border-zinc-600 hover:text-text-primary'
                                        }`}
                                    >
                                        {p.name}
                                    </button>
                                ))}
                            </div>

                            {/* Credential input */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-medium text-text-secondary">
                                    {isOllama ? 'Base URL' : 'API Key'}
                                </label>
                                <div className="relative">
                                    <input
                                        type={isOllama ? 'text' : 'password'}
                                        value={credential}
                                        onChange={(e) => setCredential(e.target.value)}
                                        placeholder={providerMeta.placeholder}
                                        className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none font-mono"
                                        autoComplete="new-password"
                                        autoFocus
                                    />
                                    {validating && (
                                        <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-text-muted" />
                                    )}
                                    {validated && !validating && (
                                        <Check className="absolute right-3 top-3 h-4 w-4 text-emerald-400" />
                                    )}
                                </div>
                                {!isOllama && providerMeta.link && (
                                    <a
                                        href={providerMeta.link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1 text-[11px] text-azure mt-0.5"
                                    >
                                        Get a key <ExternalLink className="h-3 w-3" />
                                    </a>
                                )}
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 text-xs text-red">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                                </div>
                            )}

                            <button
                                onClick={() => void saveProvider()}
                                disabled={!credential.trim() || saving}
                                className="w-full rounded-xl bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                {saving ? 'Saving...' : validated ? 'Save & continue' : 'Save & continue'}
                            </button>
                        </div>
                    )}

                    {/* ── Step 2: Name your workspace ── */}
                    {step === 2 && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-text-primary">Name your workspace</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    This is how your workspace appears in the sidebar.
                                </p>
                            </div>

                            <input
                                type="text"
                                value={wsName}
                                onChange={(e) => setWsName(e.target.value)}
                                placeholder="My Workspace"
                                className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && void updateWorkspaceName()}
                            />

                            <button
                                onClick={() => void updateWorkspaceName()}
                                disabled={saving}
                                className="w-full rounded-xl bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                Continue
                            </button>
                        </div>
                    )}

                    {/* ── Step 3: Your first task ── */}
                    {step === 3 && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-text-primary">Your first task</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    Try running a task to see Plexo in action.
                                </p>
                            </div>

                            <div className="rounded-xl border border-border bg-canvas px-4 py-3 text-sm text-text-secondary leading-relaxed">
                                {EXAMPLE_TASK}
                            </div>

                            {taskDone ? (
                                <div className="flex items-center justify-center gap-2 rounded-xl bg-azure/5 border border-azure/20 py-3 text-sm text-azure">
                                    <Check className="h-4 w-4" />
                                    Task queued — your agent will pick it up shortly.
                                </div>
                            ) : (
                                <div className="flex gap-3">
                                    <button
                                        onClick={onComplete}
                                        className="flex-1 rounded-xl border border-border py-3 text-sm text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors"
                                    >
                                        Skip
                                    </button>
                                    <button
                                        onClick={() => void submitFirstTask()}
                                        disabled={taskSubmitting}
                                        className="flex-1 rounded-xl bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                                    >
                                        {taskSubmitting ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Sparkles className="h-4 w-4" />
                                        )}
                                        Run this
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
