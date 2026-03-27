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
 *   1. Connect a model — paste any API key, auto-detect provider
 *   2. Name your workspace — single input, pre-filled
 *   3. Your first task — pre-filled example with "Run this" button
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    Check,
    ChevronDown,
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

// ── Auto-detect provider from key prefix ─────────────────────────────────────

function detectProvider(key: string): ProviderKey | null {
    const trimmed = key.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('sk-ant-')) return 'anthropic'
    if (trimmed.startsWith('sk-or-')) return 'openrouter'
    if (trimmed.startsWith('gsk_')) return 'groq'
    if (trimmed.startsWith('sk-proj-')) return 'openai'
    // Generic sk- that isn't sk-ant or sk-or => OpenAI
    if (trimmed.startsWith('sk-')) return 'openai'
    // Alphanumeric without obvious prefix => try DeepSeek
    if (/^[a-zA-Z0-9]/.test(trimmed)) return 'deepseek'
    return null
}

// ── Hook: check if any AI provider is configured ─────────────────────────────

interface ProviderEntry {
    apiKey?: string
    baseUrl?: string
    status?: string
    enabled?: boolean
}

function useHasProvider(workspaceId: string): { loading: boolean; hasProvider: boolean | null } {
    const [loading, setLoading] = useState(true)
    const [hasProvider, setHasProvider] = useState<boolean | null>(null)

    useEffect(() => {
        if (!workspaceId) { setLoading(false); return }
        let cancelled = false

        fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((data: { aiProviders?: { providers?: Record<string, ProviderEntry> } } | null) => {
                if (cancelled) return
                const providers = data?.aiProviders?.providers
                if (!providers) { setHasProvider(false); setLoading(false); return }
                // Check if at least one provider has a key or base URL set.
                // The API returns '__configured__' sentinel for keys that are set.
                const configured = Object.values(providers).some(
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
    const [credential, setCredential] = useState('')
    const [saving, setSaving] = useState(false)
    const [validating, setValidating] = useState(false)
    const [validated, setValidated] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [wsName, setWsName] = useState(workspaceName || 'My Workspace')
    const [taskSubmitting, setTaskSubmitting] = useState(false)
    const [taskDone, setTaskDone] = useState(false)
    const [showCustom, setShowCustom] = useState(false)
    const [customName, setCustomName] = useState('')
    const [customBaseUrl, setCustomBaseUrl] = useState('')

    // Auto-detect provider from key
    const detected = useMemo(() => detectProvider(credential), [credential])
    const detectedMeta = detected ? PROVIDERS.find((p) => p.key === detected) : null

    // Effective provider: custom overrides auto-detect
    const effectiveProvider: ProviderKey | null = showCustom ? null : detected
    const isOllama = effectiveProvider === 'ollama'

    // ── Live validation ──────────────────────────────────────────────────────

    const validateKey = useCallback(async () => {
        const cred = credential.trim()
        if (!cred) return

        // For custom endpoints, need a base URL
        if (showCustom && !customBaseUrl.trim()) return

        setValidating(true)
        setError(null)
        setValidated(false)
        try {
            const provider = showCustom ? 'openai' : (effectiveProvider || 'openai')
            const body: Record<string, string> = {
                provider,
                workspaceId,
            }
            if (showCustom) {
                body.baseUrl = customBaseUrl.trim()
                body.apiKey = cred
            } else if (isOllama) {
                body.baseUrl = cred || 'http://localhost:11434'
            } else {
                body.apiKey = cred
            }

            const res = await fetch(`${API_BASE}/api/v1/settings/ai-providers/probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
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
    }, [credential, effectiveProvider, isOllama, workspaceId, showCustom, customBaseUrl])

    // Debounced validation on credential change
    useEffect(() => {
        setValidated(false)
        setError(null)
        if (!credential.trim()) return
        // Don't auto-validate if no provider detected and not custom mode
        if (!showCustom && !detected) return
        const t = setTimeout(() => { void validateKey() }, 800)
        return () => clearTimeout(t)
    }, [credential, validateKey, showCustom, detected])

    // ── Save provider ────────────────────────────────────────────────────────

    async function saveProvider() {
        const cred = credential.trim()
        if (!cred && !showCustom) return

        setSaving(true)
        setError(null)

        const providerKey = showCustom
            ? `custom_${(customName.trim() || 'custom').toLowerCase().replace(/[^a-z0-9]/g, '_')}`
            : (effectiveProvider || 'openai')

        try {
            const providerEntry: Record<string, unknown> = {
                status: validated ? 'configured' : 'untested',
                enabled: true,
            }

            if (showCustom) {
                providerEntry.apiKey = cred
                providerEntry.baseUrl = customBaseUrl.trim()
                providerEntry.name = customName.trim() || 'Custom Provider'
            } else if (isOllama) {
                providerEntry.baseUrl = cred || 'http://localhost:11434'
            } else {
                providerEntry.apiKey = cred
            }

            const res = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    primary: providerKey,
                    primaryProvider: providerKey,
                    providers: {
                        [providerKey]: providerEntry,
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

    // ── Can proceed? ─────────────────────────────────────────────────────────

    const canSave = showCustom
        ? credential.trim().length > 0 && customBaseUrl.trim().length > 0
        : credential.trim().length > 0 && (detected !== null)

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
                                    Paste an API key from any supported provider. Plexo will detect which one it is.
                                </p>
                            </div>

                            {/* Single key input with auto-detection */}
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-medium text-text-secondary">
                                    {showCustom ? 'API Key' : 'Paste your API key'}
                                </label>
                                <div className="relative">
                                    <input
                                        type={showCustom ? 'text' : 'password'}
                                        value={credential}
                                        onChange={(e) => setCredential(e.target.value)}
                                        placeholder={showCustom ? 'API key for your endpoint' : 'sk-ant-…, sk-proj-…, gsk_…, sk-or-…'}
                                        className="w-full rounded-lg border border-border bg-canvas px-3 py-3 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none font-mono"
                                        autoComplete="new-password"
                                        autoFocus
                                    />
                                    {validating && (
                                        <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-text-muted" />
                                    )}
                                    {validated && !validating && (
                                        <Check className="absolute right-3 top-3.5 h-4 w-4 text-emerald-400" />
                                    )}
                                </div>

                                {/* Detected provider indicator */}
                                {!showCustom && detected && detectedMeta && credential.trim() && (
                                    <div className="flex items-center gap-1.5 mt-1">
                                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                                        <span className="text-xs text-emerald-400 font-medium">
                                            Detected: {detectedMeta.name}
                                        </span>
                                        {detectedMeta.link && (
                                            <a
                                                href={detectedMeta.link}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="ml-auto flex items-center gap-1 text-[11px] text-azure"
                                            >
                                                Get a key <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                    </div>
                                )}

                                {/* Unrecognized key warning */}
                                {!showCustom && credential.trim().length > 3 && !detected && (
                                    <div className="flex items-center gap-1.5 mt-1 text-xs text-text-muted">
                                        Could not detect provider. Use &quot;Other / Custom endpoint&quot; below.
                                    </div>
                                )}
                            </div>

                            {/* Custom / Other endpoint toggle */}
                            <div>
                                <button
                                    type="button"
                                    onClick={() => { setShowCustom(!showCustom); setValidated(false); setError(null) }}
                                    className="flex items-center gap-1.5 text-xs text-azure hover:text-azure/80 transition-colors"
                                >
                                    <ChevronDown className={`h-3 w-3 transition-transform ${showCustom ? 'rotate-180' : ''}`} />
                                    Other / Custom endpoint
                                </button>

                                {showCustom && (
                                    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-canvas/50 p-4">
                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-xs font-medium text-text-secondary">
                                                Provider name
                                            </label>
                                            <input
                                                type="text"
                                                value={customName}
                                                onChange={(e) => setCustomName(e.target.value)}
                                                placeholder="e.g. Ollama, LM Studio, Together AI"
                                                className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-xs font-medium text-text-secondary">
                                                Base URL
                                            </label>
                                            <input
                                                type="text"
                                                value={customBaseUrl}
                                                onChange={(e) => setCustomBaseUrl(e.target.value)}
                                                placeholder="http://localhost:11434/v1"
                                                className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none font-mono"
                                            />
                                        </div>
                                        <p className="text-[11px] text-text-muted">
                                            For local providers like Ollama, the API key can be any non-empty string (e.g. &quot;ollama&quot;).
                                        </p>
                                    </div>
                                )}
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 text-xs text-red">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                                </div>
                            )}

                            <button
                                onClick={() => void saveProvider()}
                                disabled={!canSave || saving}
                                className="w-full rounded-xl bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                {saving ? 'Saving...' : 'Save & continue'}
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
