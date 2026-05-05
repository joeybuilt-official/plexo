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
 *   1. Connect a provider — paste any API key, auto-detect provider
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
import { useFocusTrap } from '@web/hooks/use-focus-trap'
import { ModelCompatBadge, type ModelCompatStatus } from '@web/components/model-compat-badge'
import { getDeploymentMode, shouldShowBYOKModelCompat } from '@web/lib/feature-flags'

// ── Provider catalog ─────────────────────────────────────────────────────────

const PROVIDERS = [
    { key: 'anthropic',   name: 'Anthropic',    placeholder: 'sk-ant-api03-…',            link: 'https://console.anthropic.com/keys',         requiresUrl: false, keyOptional: false },
    { key: 'openai',      name: 'OpenAI',       placeholder: 'sk-proj-…',                 link: 'https://platform.openai.com/api-keys',       requiresUrl: false, keyOptional: false },
    { key: 'deepseek',    name: 'DeepSeek',     placeholder: 'sk-…',                      link: 'https://platform.deepseek.com/api_keys',     requiresUrl: false, keyOptional: false },
    { key: 'groq',        name: 'Groq',         placeholder: 'gsk_…',                     link: 'https://console.groq.com/keys',              requiresUrl: false, keyOptional: false },
    { key: 'cerebras',    name: 'Cerebras',     placeholder: 'csk-…',                     link: 'https://cloud.cerebras.ai',                  requiresUrl: false, keyOptional: false },
    { key: 'openrouter',  name: 'OpenRouter',   placeholder: 'sk-or-v1-…',                link: 'https://openrouter.ai/keys',                 requiresUrl: false, keyOptional: false },
    { key: 'ollama',      name: 'Ollama',       placeholder: '(usually leave blank)',     link: 'https://ollama.com/download',                requiresUrl: true,  keyOptional: true  },
] as const

type ProviderKey = typeof PROVIDERS[number]['key']

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

// ── Auto-detect provider from key prefix ─────────────────────────────────────

// Ollama intentionally NOT autodetected here — its keys are typically blank or
// arbitrary; users select Ollama explicitly via the dedicated affordance.
function detectProvider(key: string): ProviderKey | null {
    const trimmed = key.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('sk-ant-')) return 'anthropic'
    if (trimmed.startsWith('sk-or-')) return 'openrouter'
    if (trimmed.startsWith('gsk_')) return 'groq'
    if (trimmed.startsWith('csk-')) return 'cerebras'
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
    selectedModel?: string
}

function useHasProvider(workspaceId: string): { loading: boolean; hasProvider: boolean | null } {
    const [loading, setLoading] = useState(true)
    const [hasProvider, setHasProvider] = useState<boolean | null>(null)

    useEffect(() => {
        if (!workspaceId) { setLoading(false); return }
        let cancelled = false
        setLoading(true)

        // Check both the new provider_instances endpoint and the legacy ai-providers endpoint
        Promise.allSettled([
            fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/providers`, { cache: 'no-store' })
                .then(r => r.ok ? r.json() : null),
            fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`, { cache: 'no-store' })
                .then(r => r.ok ? r.json() : null),
        ]).then(([newRes, legacyRes]) => {
            if (cancelled) return

            // New provider_instances — any enabled instance counts
            if (newRes.status === 'fulfilled' && newRes.value) {
                const items = (newRes.value as { providers?: Array<{ enabled?: boolean }> }).providers
                if (items && items.some(p => p.enabled !== false)) {
                    setHasProvider(true)
                    setLoading(false)
                    return
                }
            }

            // Legacy ai-providers fallback
            if (legacyRes.status === 'fulfilled' && legacyRes.value) {
                const blob = (legacyRes.value as { aiProviders?: { primaryProvider?: string; providers?: Record<string, ProviderEntry> } }).aiProviders
                const providers = blob?.providers
                if (blob?.primaryProvider || (providers && Object.values(providers).some(
                    p => (p.apiKey && p.apiKey.length > 0) || (p.baseUrl && p.baseUrl.length > 0) || p.enabled === true || !!p.selectedModel
                ))) {
                    setHasProvider(true)
                    setLoading(false)
                    return
                }
            }

            setHasProvider(false)
            setLoading(false)
        }).catch(() => { if (!cancelled) { setHasProvider(null); setLoading(false) } })

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
    const [showOllama, setShowOllama] = useState(false)
    const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
    const trapRef = useFocusTrap<HTMLDivElement>(true)

    // Model-compat post-save state (Phase I Stage 2 — C2 audience-split).
    // We surface the backend's pre-flight structured-output check inline
    // before the user advances to step 2. BYOK path only.
    const [savedInstance, setSavedInstance] = useState<{
        id: string
        modelCompatStatus: ModelCompatStatus
        modelCompatValidatedAt: string | null
    } | null>(null)
    const [revalidating, setRevalidating] = useState(false)

    // Auto-detect provider from key
    const detected = useMemo(() => detectProvider(credential), [credential])
    const detectedMeta = detected ? PROVIDERS.find((p) => p.key === detected) : null

    // Effective provider: ollama / custom override auto-detect
    const effectiveProvider: ProviderKey | null = showOllama ? 'ollama' : (showCustom ? null : detected)

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
    }, [credential, effectiveProvider, workspaceId, showCustom, customBaseUrl])

    // Debounced validation on credential change
    useEffect(() => {
        setValidated(false)
        setError(null)
        if (showOllama) return
        if (!credential.trim()) return
        // Don't auto-validate if no provider detected and not custom mode
        if (!showCustom && !detected) return
        const t = setTimeout(() => { void validateKey() }, 800)
        return () => clearTimeout(t)
    }, [credential, validateKey, showCustom, detected, showOllama])

    // ── Save provider ────────────────────────────────────────────────────────

    async function saveProvider() {
        const cred = credential.trim()
        if (showOllama) {
            if (!ollamaUrl.trim()) return
        } else if (!cred && !showCustom) {
            return
        }

        setSaving(true)
        setError(null)

        // Ollama: post directly to the new provider_instances endpoint with the
        // BYOK Ollama shape. Legacy ai-providers blob doesn't model Ollama, so
        // skip the double-write.
        if (showOllama) {
            try {
                const body: Record<string, unknown> = {
                    nickname: 'Ollama',
                    providerType: 'ollama',
                    endpointUrl: ollamaUrl.trim(),
                }
                if (cred) body.apiKey = cred
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/providers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                if (!res.ok) {
                    const data = await res.json().catch(() => ({})) as { error?: string; message?: string }
                    setError(data.error || data.message || 'Could not reach that Ollama server. Check the URL and try again.')
                    return
                }
                const data = await res.json().catch(() => ({})) as {
                    provider?: {
                        id?: string
                        modelCompatStatus?: ModelCompatStatus
                        modelCompatValidatedAt?: string | null
                    }
                }
                if (data.provider?.id) {
                    setSavedInstance({
                        id: data.provider.id,
                        modelCompatStatus: data.provider.modelCompatStatus ?? null,
                        modelCompatValidatedAt: data.provider.modelCompatValidatedAt ?? null,
                    })
                    return
                }
                setStep(2)
            } catch {
                setError('Network error — could not save provider.')
            } finally {
                setSaving(false)
            }
            return
        }

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
            } else {
                providerEntry.apiKey = cred
            }

            // Save to legacy endpoint
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

            // Also save to new provider_instances endpoint for consistency
            const newBody: Record<string, unknown> = {
                nickname: showCustom ? (customName.trim() || 'Custom Provider') : (providerKey.charAt(0).toUpperCase() + providerKey.slice(1)),
                providerType: showCustom ? 'openai' : providerKey,
            }
            if (showCustom) {
                newBody.apiKey = cred
                newBody.endpointUrl = customBaseUrl.trim()
            } else {
                newBody.apiKey = cred
            }
            // Await the second save — legacy endpoint above is authoritative,
            // so if this fails we log but don't block the wizard. We DO want
            // its response when it succeeds, since the new endpoint is the
            // one that records `modelCompatStatus`.
            try {
                const newRes = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/providers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newBody),
                })
                if (newRes.ok) {
                    const data = await newRes.json().catch(() => ({})) as {
                        provider?: {
                            id?: string
                            modelCompatStatus?: ModelCompatStatus
                            modelCompatValidatedAt?: string | null
                        }
                    }
                    if (data.provider?.id) {
                        setSavedInstance({
                            id: data.provider.id,
                            modelCompatStatus: data.provider.modelCompatStatus ?? null,
                            modelCompatValidatedAt: data.provider.modelCompatValidatedAt ?? null,
                        })
                        // Stay on step 1 — user reviews compat status, then
                        // clicks Continue. BYOK path always lands here; the
                        // wizard itself doesn't run on managed-default Cloud.
                        return
                    }
                }
            } catch (e) {
                console.warn('[setup-wizard] provider_instances save failed:', e)
            }

            // Fallback: legacy save succeeded but new endpoint did not return
            // a usable instance. Skip compat surfacing and advance.
            setStep(2)
        } catch {
            setError('Network error — could not save provider.')
        } finally {
            setSaving(false)
        }
    }

    /**
     * Re-trigger the backend pre-flight model-compat check on the just-saved
     * instance. PATCH with the current selectedModel (or none) re-runs the
     * synthetic generateObject probe and updates `modelCompatStatus`.
     */
    const handleRevalidate = useCallback(async () => {
        if (!savedInstance) return
        setRevalidating(true)
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces/${workspaceId}/providers/${savedInstance.id}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                },
            )
            if (res.ok) {
                const data = await res.json().catch(() => ({})) as {
                    provider?: {
                        modelCompatStatus?: ModelCompatStatus
                        modelCompatValidatedAt?: string | null
                    }
                }
                if (data.provider) {
                    setSavedInstance({
                        ...savedInstance,
                        modelCompatStatus: data.provider.modelCompatStatus ?? null,
                        modelCompatValidatedAt: data.provider.modelCompatValidatedAt ?? null,
                    })
                }
            }
        } catch { /* non-fatal — leave existing state in place */ }
        finally { setRevalidating(false) }
    }, [savedInstance, workspaceId])

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

    const canSave = showOllama
        ? ollamaUrl.trim().length > 0
        : showCustom
            ? credential.trim().length > 0 && customBaseUrl.trim().length > 0
            : credential.trim().length > 0 && (detected !== null)

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-wizard-title"
        >
            <div className="relative w-full max-w-lg mx-4 rounded border border-border bg-surface-1 overflow-hidden">
                {/* Visually-hidden title for screen readers */}
                <h2 id="setup-wizard-title" className="sr-only">Workspace Setup Wizard</h2>
                {/* Dismiss button */}
                <button
                    onClick={onDismiss}
                    className="absolute top-4 right-4 p-1.5 rounded text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors z-10"
                    title="Skip for now"
                    aria-label="Skip for now"
                >
                    <X className="h-4 w-4" />
                </button>

                {/* Step indicator */}
                <div className="flex items-center gap-2 px-7 pt-6 pb-2">
                    {[1, 2, 3].map((s) => (
                        <div key={s} className="flex items-center gap-2">
                            <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all ${
                                s < step ? 'bg-azure text-white' :
                                s === step ? 'border-2 border-azure text-azure' :
                                'border border-border text-text-muted'
                            }`}>
                                {s < step ? <Check className="h-3 w-3" /> : s}
                            </div>
                            <span className={`text-xs ${s === step ? 'text-text-primary font-medium' : 'text-text-muted'}`}>
                                {s === 1 ? 'Connect' : s === 2 ? 'Name' : 'First task'}
                            </span>
                            {s < 3 && <ChevronRight className="h-3 w-3 text-text-muted" />}
                        </div>
                    ))}
                </div>

                <div className="px-7 pb-7 pt-4">
                    {/* ── Step 1: Connect a provider ── */}
                    {step === 1 && savedInstance && shouldShowBYOKModelCompat(getDeploymentMode(), true) && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">Provider connected</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    We checked whether this model can produce the structured output Plexo agents rely on.
                                </p>
                            </div>

                            <ModelCompatBadge
                                status={savedInstance.modelCompatStatus}
                                validatedAt={savedInstance.modelCompatValidatedAt}
                                onRevalidate={handleRevalidate}
                                revalidating={revalidating}
                            />

                            <button
                                onClick={() => setStep(2)}
                                className="w-full rounded bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors"
                            >
                                Continue
                            </button>
                        </div>
                    )}
                    {step === 1 && (savedInstance && !shouldShowBYOKModelCompat(getDeploymentMode(), true)) && (
                        // Managed-default cloud users shouldn't normally see this
                        // wizard at all; if they somehow do, just advance silently
                        // per C2 (Sam-side: never expose compat to managed users).
                        // We trigger the advance via an effect-style render.
                        (() => { setTimeout(() => setStep(2), 0); return null })()
                    )}
                    {step === 1 && !savedInstance && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">Connect an AI model</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    Plexo runs your tasks, schedules, and channels — it needs a model to think with.
                                    Connect any provider you already use (OpenAI, Anthropic, DeepSeek, Groq…), or
                                    point Plexo at your own Ollama server.
                                </p>
                                <p className="mt-1.5 text-xs text-text-muted leading-relaxed">
                                    Pick whatever you have. There&apos;s no &quot;right&quot; choice — you can change it
                                    later, add more providers, or set fallbacks in Settings.
                                </p>
                            </div>

                            {/* Mode selector: paste a key  |  use Ollama */}
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    aria-pressed={!showOllama}
                                    onClick={() => { setShowOllama(false); setError(null) }}
                                    className={`flex-1 rounded border px-3 py-2 text-xs font-medium transition-colors ${
                                        !showOllama
                                            ? 'border-azure bg-azure/10 text-azure'
                                            : 'border-border bg-canvas text-text-secondary hover:border-border'
                                    }`}
                                >
                                    Paste an API key
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={showOllama}
                                    onClick={() => { setShowOllama(true); setShowCustom(false); setError(null); setValidated(false) }}
                                    className={`flex-1 rounded border px-3 py-2 text-xs font-medium transition-colors ${
                                        showOllama
                                            ? 'border-azure bg-azure/10 text-azure'
                                            : 'border-border bg-canvas text-text-secondary hover:border-border'
                                    }`}
                                >
                                    I&apos;m using Ollama
                                </button>
                            </div>

                            {/* Ollama path: URL required, key optional */}
                            {showOllama && (
                                <div className="flex flex-col gap-3 rounded border border-border bg-canvas/50 p-4">
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-xs font-medium text-text-secondary">
                                            Ollama server URL
                                        </label>
                                        <input
                                            type="text"
                                            value={ollamaUrl}
                                            onChange={(e) => setOllamaUrl(e.target.value)}
                                            placeholder="http://localhost:11434"
                                            className="rounded border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                                            autoFocus
                                        />
                                        <p className="text-[11px] text-text-muted">
                                            Local Ollama is usually <code className="font-mono">http://localhost:11434</code>.
                                            For a self-hosted remote server, use that hostname.
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-xs font-medium text-text-secondary">
                                            API key <span className="text-text-muted font-normal">(optional)</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={credential}
                                            onChange={(e) => setCredential(e.target.value)}
                                            placeholder="leave blank for local Ollama"
                                            className="rounded border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                                            autoComplete="off"
                                        />
                                        <p className="text-[11px] text-text-muted">
                                            Most local Ollama installs don&apos;t use auth. Add a key only if your
                                            server is fronted by a reverse proxy that requires one.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* API-key path */}
                            {!showOllama && (
                                <>
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
                                                className="w-full rounded border border-border bg-canvas px-3 py-3 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
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

                                        {!showCustom && credential.trim().length > 3 && !detected && (
                                            <div className="flex items-center gap-1.5 mt-1 text-xs text-text-muted">
                                                Could not detect provider. Use &quot;Other / Custom endpoint&quot; below.
                                            </div>
                                        )}
                                    </div>

                                    {/* Free-tier suggestions — framed as good defaults, not requirements */}
                                    <div className="rounded border border-border/40 bg-canvas/50 px-3 py-2.5">
                                        <p className="text-[11px] font-medium text-text-secondary mb-1.5">Don&apos;t have a key yet? These have free tiers:</p>
                                        <div className="flex flex-col gap-1">
                                            <a href="https://cloud.cerebras.ai" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[11px] text-azure hover:text-azure/80 transition-colors">
                                                Cerebras — fastest inference, free tier <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                            <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[11px] text-azure hover:text-azure/80 transition-colors">
                                                Groq — ultra-fast Llama &amp; Mixtral <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[11px] text-azure hover:text-azure/80 transition-colors">
                                                DeepSeek — reasoning models, very low cost <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                        </div>
                                    </div>

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
                                            <div className="mt-3 flex flex-col gap-3 rounded border border-border bg-canvas/50 p-4">
                                                <div className="flex flex-col gap-1.5">
                                                    <label className="text-xs font-medium text-text-secondary">
                                                        Provider name
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={customName}
                                                        onChange={(e) => setCustomName(e.target.value)}
                                                        placeholder="e.g. LM Studio, Together AI"
                                                        className="rounded border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
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
                                                        placeholder="https://api.example.com/v1"
                                                        className="rounded border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring font-mono"
                                                    />
                                                </div>
                                                <p className="text-[11px] text-text-muted">
                                                    Any OpenAI-compatible endpoint. For Ollama, use the dedicated &quot;I&apos;m using Ollama&quot; option above.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}

                            {error && (
                                <div className="flex items-center gap-2 text-xs text-red">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                                </div>
                            )}

                            <button
                                onClick={() => void saveProvider()}
                                disabled={!canSave || saving}
                                className="w-full rounded bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                {saving ? 'Saving...' : 'Save & continue'}
                            </button>

                            {/* Skip-for-now affordance — fixes the dismissed-wizard dead end.
                                Routes user to Settings → Intelligence so they have a clear
                                place to add a provider later. */}
                            <button
                                type="button"
                                onClick={() => {
                                    try {
                                        localStorage.setItem(`plexo_wizard_dismissed_${workspaceId}`, 'true')
                                    } catch { /* non-fatal */ }
                                    window.location.href = '/app/settings/intelligence/providers'
                                }}
                                className="text-center text-xs text-text-muted hover:text-text-secondary transition-colors"
                            >
                                Skip for now — I&apos;ll add a provider in Settings
                            </button>
                        </div>
                    )}

                    {/* ── Step 2: Name your workspace ── */}
                    {step === 2 && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-semibold text-text-primary">Name your workspace</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    This is how your workspace appears in the sidebar.
                                </p>
                            </div>

                            <input
                                type="text"
                                value={wsName}
                                onChange={(e) => setWsName(e.target.value)}
                                placeholder="My Workspace"
                                className="rounded border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && void updateWorkspaceName()}
                            />

                            <button
                                onClick={() => void updateWorkspaceName()}
                                disabled={saving}
                                className="w-full rounded bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
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
                                <h2 className="text-lg font-semibold text-text-primary">Your first task</h2>
                                <p className="mt-1 text-sm text-text-secondary">
                                    Try running a task to see Plexo in action.
                                </p>
                            </div>

                            <div className="rounded border border-border bg-canvas px-4 py-3 text-sm text-text-secondary leading-relaxed">
                                {EXAMPLE_TASK}
                            </div>

                            {taskDone ? (
                                <div className="flex items-center justify-center gap-2 rounded bg-azure/5 border border-azure/20 py-3 text-sm text-azure">
                                    <Check className="h-4 w-4" />
                                    Task queued — your agent will pick it up shortly.
                                </div>
                            ) : (
                                <div className="flex gap-3">
                                    <button
                                        onClick={onComplete}
                                        className="flex-1 rounded border border-border py-3 text-sm text-text-secondary hover:border-border hover:text-text-primary transition-colors"
                                    >
                                        Skip
                                    </button>
                                    <button
                                        onClick={() => void submitFirstTask()}
                                        disabled={taskSubmitting}
                                        className="flex-1 rounded bg-azure py-3 text-sm font-semibold text-white hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
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
